import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
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
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3466

/**
 * @param {SsrNode[]} nodes
 * @param {{ intervalSeconds?: number, requestTimeoutSeconds?: number, targetUrl?: string, mihomoBinary?: string, telegramBotToken?: string, telegramChatId?: string, telegramProxy?: string, host?: string, port?: number }} options
 */
export async function createSsrMonitor(nodes, options = {}) {
  const intervalSeconds = normalizePositiveInt(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, '轮询间隔')
  const requestTimeoutSeconds = normalizePositiveInt(options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS, '请求超时')
  const targetUrl = options.targetUrl ?? DEFAULT_TARGET_URL
  const mihomoBinary = options.mihomoBinary ?? DEFAULT_MIHOMO_BINARY
  const host = options.host ?? DEFAULT_HOST
  const port = normalizePositiveInt(options.port ?? DEFAULT_PORT, '端口')
  const telegram = createTelegramNotifier(options.telegramBotToken, options.telegramChatId, options.telegramProxy ?? DEFAULT_TELEGRAM_PROXY)

  const socksPort = await getFreePort()
  const controllerPort = await getFreePort()
  const secret = ''
  const tempDir = await mkdtemp(join(tmpdir(), 'ssr-monitor-'))
  const configPath = join(tempDir, 'mihomo-ssr.yaml')
  const groupName = 'SSR'
  const html = renderSsrDashboardHtml()
  const state = nodes.map(node => ({
    id: node.id,
    name: node.name,
    server: node.server,
    port: node.port,
    alertActive: false,
    status: 'idle',
    lastError: undefined,
    lastCheckedAt: undefined,
  }))
  let nextRunAt = undefined
  let currentNodeName = undefined
  const httpServer = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }

    if (pathname === '/api/state') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        server: {
          origin: `http://${host}:${port}`,
        },
        settings: {
          intervalSeconds,
          requestTimeoutSeconds,
          targetUrl,
        },
        cycle: {
          currentNodeName,
          nextRunAt,
        },
        nodes: state.map(node => ({ ...node })),
      }))
      return
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'not found' }))
  })

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
        currentNodeName = node.name
        console.log(`[SSR] 切换节点: ${node.name} -> ${node.server}:${node.port}`)
        await selectProxy(controllerPort, secret, groupName, node.name)
        await sleep(300)
        const probe = await runCurlProbe(socksPort, targetUrl, requestTimeoutSeconds)
        current.lastCheckedAt = new Date().toISOString()
        current.lastError = undefined
        current.status = 'up'
        console.log(`[SSR] ${node.name} UP total=${probe.timeTotal}s connect=${probe.timeConnect}s starttransfer=${probe.timeStartTransfer}s remote=${node.server}:${node.port}`)

        if (current.alertActive) {
          current.alertActive = false
          await sendTelegramAlert(telegram, `✅ SSR 节点恢复\n${node.name}\n${node.server}:${node.port}`)
        }
      }
      catch (error) {
        current.lastCheckedAt = new Date().toISOString()
        current.lastError = formatError(error)
        current.status = 'down'
        console.log(`[SSR] ${node.name} DOWN ${current.lastError}`)

        if (!current.alertActive) {
          current.alertActive = true
          await sendTelegramAlert(telegram, `⚠️ SSR 节点疑似故障\n${node.name}\n${node.server}:${node.port}\n${current.lastError}`)
        }
      }
    }

    if (!stopping) {
      console.log(`[SSR] 等待 ${intervalSeconds} 秒后进入下一轮`)
      currentNodeName = undefined
      nextRunAt = new Date(Date.now() + intervalSeconds * 1000).toISOString()
      loopTimer = setTimeout(() => {
        nextRunAt = undefined
        void runCycle()
      }, intervalSeconds * 1000)
    }
  }

  return {
    async start() {
      await new Promise((resolve, reject) => {
        const onError = error => {
          httpServer.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          httpServer.off('error', onError)
          resolve(undefined)
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(port, host)
      })

      void runCycle()
      for (const node of nodes) {
        console.log(`[SSR] 已加载节点: ${node.name} -> ${node.server}:${node.port}`)
      }
      return {
        intervalSeconds,
        requestTimeoutSeconds,
        targetUrl,
        mihomoBinary,
        configPath,
        socksPort,
        controllerPort,
        dashboardOrigin: `http://${host}:${port}`,
        telegramEnabled: telegram.enabled,
        telegramProxy: telegram.proxy,
      }
    },
    async stop() {
      stopping = true
      clearTimeout(loopTimer)
      await new Promise(resolve => {
        httpServer.close(() => resolve(undefined))
      })
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
    'mode: rule',
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
    '--write-out', '\n%{time_total}|%{time_connect}|%{time_starttransfer}',
    targetUrl,
  ]

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

  const line = stdout.trim().split('\n').at(-1) ?? ''
  const [timeTotal, timeConnect, timeStartTransfer] = line.split('|')
  return {
    timeTotal: timeTotal || '0',
    timeConnect: timeConnect || '0',
    timeStartTransfer: timeStartTransfer || '0',
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
    const server = createNetServer()
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

function renderSsrDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SSR Monitor</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f7fb; color: #122033; }
      .shell { max-width: 980px; margin: 0 auto; padding: 28px; }
      .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 20px; }
      .hero h1 { margin: 0; font-size: 28px; }
      .hero p { margin: 6px 0 0; color: #52627a; }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
      .stat, .node { background: #fff; border: 1px solid #dbe3ef; border-radius: 16px; padding: 16px; box-shadow: 0 10px 24px rgba(16, 24, 40, 0.06); }
      .stat strong { display: block; font-size: 24px; margin-bottom: 4px; }
      .muted { color: #5f6f86; }
      .list { display: grid; gap: 12px; }
      .node { display: grid; grid-template-columns: 1fr auto; gap: 12px; }
      .node h2 { margin: 0 0 6px; font-size: 18px; }
      .meta { color: #66778f; font-size: 14px; margin-bottom: 6px; }
      .status { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 12px; font-weight: 700; }
      .status.up { background: #e7f8ee; color: #137a43; }
      .status.down { background: #ffeaea; color: #c73a3a; }
      .status.idle { background: #eef2f7; color: #59697d; }
      @media (max-width: 760px) {
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .node { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div>
          <h1>SSR 独立监控</h1>
          <p>通过 Mihomo 常驻测试少量 SSR 节点。</p>
        </div>
        <div class="muted" id="origin">正在连接...</div>
      </section>
      <section class="stats">
        <article class="stat"><strong id="count-total">0</strong><span class="muted">节点总数</span></article>
        <article class="stat"><strong id="count-up">0</strong><span class="muted">当前可用</span></article>
        <article class="stat"><strong id="current-node">-</strong><span class="muted">当前检测</span></article>
        <article class="stat"><strong id="next-run">-</strong><span class="muted">下次轮询</span></article>
      </section>
      <section class="list" id="node-list"></section>
    </main>
    <script>
      const origin = document.getElementById('origin')
      const countTotal = document.getElementById('count-total')
      const countUp = document.getElementById('count-up')
      const currentNode = document.getElementById('current-node')
      const nextRun = document.getElementById('next-run')
      const nodeList = document.getElementById('node-list')

      function formatDateTime(value) {
        if (!value) return '未开始'
        const date = new Date(value)
        if (Number.isNaN(date.getTime())) return '未开始'
        return new Intl.DateTimeFormat('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(date)
      }

      function formatNextRun(value) {
        if (!value) return '-'
        const date = new Date(value)
        if (Number.isNaN(date.getTime())) return '-'
        const diff = Math.max(0, Math.round((date.getTime() - Date.now()) / 1000))
        return diff <= 1 ? '即将开始' : diff + ' 秒后'
      }

      function render(snapshot) {
        origin.textContent = snapshot.server.origin
        countTotal.textContent = String(snapshot.nodes.length)
        countUp.textContent = String(snapshot.nodes.filter(node => node.status === 'up').length)
        currentNode.textContent = snapshot.cycle.currentNodeName || '-'
        nextRun.textContent = formatNextRun(snapshot.cycle.nextRunAt)
        nodeList.innerHTML = ''

        for (const node of snapshot.nodes) {
          const item = document.createElement('article')
          item.className = 'node'
          item.innerHTML = \`
            <div>
              <h2>\${node.name}</h2>
              <div class="meta">\${node.server}:\${node.port}</div>
              <div class="meta">最后检测：\${formatDateTime(node.lastCheckedAt)}</div>
              <div class="meta">\${node.lastError ? '最近错误：' + node.lastError : '最近一次检测正常'}</div>
            </div>
            <div class="status \${node.status === 'up' ? 'up' : node.status === 'down' ? 'down' : 'idle'}">\${node.status.toUpperCase()}</div>
          \`
          nodeList.appendChild(item)
        }
      }

      async function refresh() {
        const response = await fetch('/api/state')
        if (!response.ok) {
          throw new Error('状态读取失败')
        }
        render(await response.json())
      }

      refresh().catch(error => {
        origin.textContent = error instanceof Error ? error.message : String(error)
      })
      setInterval(() => {
        refresh().catch(() => {})
      }, 1000)
    </script>
  </body>
</html>`
}
