import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * @typedef {import('./ssr-config.mjs').SsrNode} SsrNode
 */

const DEFAULT_INTERVAL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 8
const DEFAULT_TARGET_URL = 'https://www.gstatic.com/generate_204'
const DEFAULT_MIHOMO_BINARY = process.env.MIHOMO_BINARY ?? 'mihomo'
const DEFAULT_TELEGRAM_PROXY = process.env.TELEGRAM_PROXY ?? 'http://127.0.0.1:7897'

/**
 * @param {SsrNode[]} nodes
 * @param {{ intervalSeconds?: number, requestTimeoutSeconds?: number, targetUrl?: string, mihomoBinary?: string, telegramBotToken?: string, telegramChatId?: string, telegramProxy?: string }} options
 */
export async function createSsrMonitor(nodes, options = {}) {
  const intervalSeconds = normalizePositiveInt(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, '轮询间隔')
  const requestTimeoutSeconds = normalizePositiveInt(options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS, '请求超时')
  const targetUrl = options.targetUrl ?? DEFAULT_TARGET_URL
  const mihomoBinary = options.mihomoBinary ?? DEFAULT_MIHOMO_BINARY
  const telegram = createTelegramNotifier(options.telegramBotToken, options.telegramChatId, options.telegramProxy ?? DEFAULT_TELEGRAM_PROXY)

  const socksPort = await getFreePort()
  const controllerPort = await getFreePort()
  const secret = ''
  const tempDir = await mkdtemp(join(tmpdir(), 'ssr-monitor-'))
  const configPath = join(tempDir, 'mihomo-ssr.yaml')
  const groupName = 'SSR'
  const state = nodes.map(node => ({
    id: node.id,
    name: node.name,
    alertActive: false,
    lastError: undefined,
    lastCheckedAt: undefined,
  }))

  const configText = buildMihomoConfig(nodes, {
    socksPort,
    controllerPort,
    secret,
    groupName,
  })
  await writeFile(configPath, configText, 'utf8')

  const mihomo = spawn(mihomoBinary, ['-f', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stopping = false
  mihomo.stdout?.on('data', () => {})
  mihomo.stderr?.on('data', () => {})

  await waitForController(controllerPort, secret)

  let loopTimer = undefined

  async function runCycle() {
    for (const node of nodes) {
      if (stopping) {
        return
      }

      const current = state.find(item => item.id === node.id)
      if (!current) {
        continue
      }

      try {
        console.log(`[SSR] 切换节点: ${node.name}`)
        await selectProxy(controllerPort, secret, groupName, node.name)
        await sleep(300)
        await runCurlProbe(socksPort, targetUrl, requestTimeoutSeconds)
        current.lastCheckedAt = new Date().toISOString()
        current.lastError = undefined
        console.log(`[SSR] ${node.name} UP`)

        if (current.alertActive) {
          current.alertActive = false
          await sendTelegramAlert(telegram, `✅ SSR 节点恢复\n${node.name}\n${node.server}:${node.port}`)
        }
      }
      catch (error) {
        current.lastCheckedAt = new Date().toISOString()
        current.lastError = formatError(error)
        console.log(`[SSR] ${node.name} DOWN ${current.lastError}`)

        if (!current.alertActive) {
          current.alertActive = true
          await sendTelegramAlert(telegram, `⚠️ SSR 节点疑似故障\n${node.name}\n${node.server}:${node.port}\n${current.lastError}`)
        }
      }
    }

    if (!stopping) {
      console.log(`[SSR] 等待 ${intervalSeconds} 秒后进入下一轮`)
      loopTimer = setTimeout(() => {
        void runCycle()
      }, intervalSeconds * 1000)
    }
  }

  return {
    async start() {
      void runCycle()
      return {
        intervalSeconds,
        requestTimeoutSeconds,
        targetUrl,
        mihomoBinary,
        configPath,
        socksPort,
        controllerPort,
        telegramEnabled: telegram.enabled,
        telegramProxy: telegram.proxy,
      }
    },
    async stop() {
      stopping = true
      clearTimeout(loopTimer)
      mihomo.kill('SIGTERM')
      await Promise.race([once(mihomo, 'exit'), sleep(1500)]).catch(() => {})
      if (!mihomo.killed) {
        mihomo.kill('SIGKILL')
      }
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

function buildMihomoConfig(nodes, options) {
  const proxyEntries = nodes.map(node => [
    `  - name: "${escapeYaml(node.name)}"`,
    '    type: ssr',
    `    server: ${node.server}`,
    `    port: ${node.port}`,
    `    cipher: ${node.cipher}`,
    `    password: "${escapeYaml(node.password)}"`,
    `    protocol: ${node.protocol}`,
    `    protocol-param: "${escapeYaml(node.protocolParam ?? '')}"`,
    `    obfs: ${node.obfs}`,
    `    obfs-param: "${escapeYaml(node.obfsParam ?? '')}"`,
    `    udp: ${node.udp === true ? 'true' : 'false'}`,
  ].join('\n')).join('\n')

  const names = nodes.map(node => `      - "${escapeYaml(node.name)}"`).join('\n')

  return [
    `mixed-port: ${options.socksPort}`,
    'allow-lan: false',
    'mode: global',
    'log-level: warning',
    `external-controller: 127.0.0.1:${options.controllerPort}`,
    'secret: ""',
    'dns:',
    '  enable: true',
    '  ipv6: false',
    'proxies:',
    proxyEntries,
    'proxy-groups:',
    `  - name: "${options.groupName}"`,
    '    type: select',
    '    proxies:',
    names,
    'rules:',
    `  - MATCH,${options.groupName}`,
    '',
  ].join('\n')
}

async function waitForController(controllerPort, secret) {
  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    try {
      await apiRequest(controllerPort, secret, 'GET', '/version')
      return
    }
    catch {
      await sleep(300)
    }
  }

  throw new Error('mihomo 控制接口启动超时')
}

async function selectProxy(controllerPort, secret, groupName, proxyName) {
  await apiRequest(controllerPort, secret, 'PUT', `/proxies/${encodeURIComponent(groupName)}`, {
    name: proxyName,
  })
}

async function apiRequest(controllerPort, secret, method, path, body) {
  const args = [
    '--silent',
    '--show-error',
    '--request', method,
    '--write-out', '\n%{http_code}',
  ]

  if (secret) {
    args.push('--header', `Authorization: Bearer ${secret}`)
  }

  if (body !== undefined) {
    args.push('--header', 'content-type: application/json', '--data-binary', JSON.stringify(body))
  }

  args.push(`http://127.0.0.1:${controllerPort}${path}`)

  const child = spawn('curl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', chunk => {
    stderr += chunk.toString()
  })

  const [code] = /** @type {[number | null, NodeJS.Signals | null]} */ (await once(child, 'exit'))
  if (code !== 0) {
    throw new Error(stderr.trim() || `curl exit code ${code}`)
  }

  const output = stdout.trimEnd()
  const splitIndex = output.lastIndexOf('\n')
  const responseBody = splitIndex >= 0 ? output.slice(0, splitIndex) : output
  const statusCode = Number(splitIndex >= 0 ? output.slice(splitIndex + 1) : '0')

  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new Error(responseBody || `HTTP ${statusCode}`)
  }

  return responseBody
}

async function runCurlProbe(socksPort, targetUrl, timeoutSeconds) {
  const args = [
    '--silent',
    '--show-error',
    '--fail',
    '--output', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '--proxy', `socks5h://127.0.0.1:${socksPort}`,
    '--max-time', String(timeoutSeconds),
    targetUrl,
  ]

  const child = spawn('curl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr?.on('data', chunk => {
    stderr += chunk.toString()
  })

  const [code] = /** @type {[number | null, NodeJS.Signals | null]} */ (await once(child, 'exit'))
  if (code !== 0) {
    throw new Error(stderr.trim() || `curl exit code ${code}`)
  }
}

function createTelegramNotifier(botToken, chatId, proxyUrl) {
  if (!botToken || !chatId) {
    return {
      enabled: false,
      async sendMessage() {},
    }
  }

  return {
    enabled: true,
    async sendMessage(text) {
      const args = [
        '--silent',
        '--show-error',
        '--header', 'content-type: application/json',
        '--data-binary', '@-',
        `https://api.telegram.org/bot${botToken}/sendMessage`,
      ]

      if (proxyUrl) {
        args.unshift(proxyUrl)
        args.unshift('--proxy')
      }

      const child = spawn('curl', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.stdin?.end(Buffer.from(JSON.stringify({
        chat_id: chatId,
        text,
      }), 'utf8'))

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', chunk => {
        stderr += chunk.toString()
      })

      const [code] = /** @type {[number | null, NodeJS.Signals | null]} */ (await once(child, 'exit'))
      if (code !== 0) {
        throw new Error(stderr.trim() || `curl exit code ${code}`)
      }

      const response = JSON.parse(stdout)
      if (!response.ok) {
        throw new Error(response.description ?? 'unknown telegram error')
      }
    },
  }
}

async function sendTelegramAlert(telegram, text) {
  if (!telegram.enabled) {
    return
  }

  await telegram.sendMessage(text)
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配端口'))
        return
      }
      server.close(() => resolve(address.port))
    })
    server.on('error', reject)
  })
}

function normalizePositiveInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label}必须是正整数`)
  }
  return number
}

function escapeYaml(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
