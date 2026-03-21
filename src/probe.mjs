import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Socket } from 'node:net'

const DEFAULT_TARGET_URL = 'https://www.gstatic.com/generate_204'
const DEFAULT_STARTUP_TIMEOUT_MS = 4000
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10

/**
 * @typedef {import('./config.mjs').ProbeNode} ProbeNode
 */

/**
 * @typedef {Object} ProbeResult
 * @property {string} nodeId
 * @property {string} name
 * @property {boolean} ok
 * @property {string} checkedAt
 * @property {number} durationMs
 * @property {string=} error
 * @property {string=} debugConfigPath
 */

/**
 * @param {ProbeNode} node
 * @param {{ targetUrl?: string, startupTimeoutMs?: number, requestTimeoutSeconds?: number, debug?: boolean, logger?: (message: string) => void }} [options]
 * @returns {Promise<ProbeResult>}
 */
export async function probeNode(node, options = {}) {
  const targetUrl = options.targetUrl ?? DEFAULT_TARGET_URL
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const requestTimeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS
  const debug = options.debug === true
  const log = options.logger ?? (() => {})
  const localPort = await getFreePort()
  const startedAt = Date.now()
  log(`allocated local port ${localPort}`)
  const runtime = await prepareProxyRuntime(node, localPort, { debug, logger: log })
  const probePort = runtime.localPort ?? localPort
  log(`runtime binary: ${runtime.binary}`)
  log(`runtime args: ${runtime.args.join(' ')}`)
  log(`probe port: ${probePort}`)
  if (runtime.debugConfigPath) {
    log(`config file: ${runtime.debugConfigPath}`)
  }
  if (runtime.debugConfigText) {
    log('generated config:')
    for (const line of runtime.debugConfigText.trimEnd().split('\n')) {
      log(`  ${line}`)
    }
  }

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child

  try {
    log(`spawning local proxy`)
    child = spawnLocalProxy(runtime)
    log(`waiting for proxy startup up to ${startupTimeoutMs}ms`)
    await waitForProxyReady(child, probePort, startupTimeoutMs, log)
    log(`starting curl probe to ${targetUrl} with timeout ${requestTimeoutSeconds}s`)
    await runCurlProbe(probePort, targetUrl, requestTimeoutSeconds, log)
    log(`probe finished successfully`)

    return {
      nodeId: node.id,
      name: node.name,
      ok: true,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      debugConfigPath: runtime.debugConfigPath,
    }
  }
  catch (error) {
    log(`probe failed: ${formatError(error)}`)
    return {
      nodeId: node.id,
      name: node.name,
      ok: false,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: formatError(error),
      debugConfigPath: runtime.debugConfigPath,
    }
  }
  finally {
    if (child && !child.killed) {
      log(`stopping local proxy`)
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(800)]).catch(() => {})
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }

    await runtime.cleanup(debug)
  }
}

/**
 * @param {{ binary: string, args: string[] }} runtime
 */
function spawnLocalProxy(runtime) {
  const binary = runtime.binary
  const child = spawn(runtime.binary, runtime.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  let stdout = ''

  child.stdout?.on('data', chunk => {
    const text = chunk.toString()
    stdout += text
    runtime.logOutput('stdout', text)
  })

  child.stderr?.on('data', chunk => {
    const text = chunk.toString()
    stderr += text
    runtime.logOutput('stderr', text)
  })

  child.on('error', error => {
    child.emit('probe-error', new Error(`启动 ${binary} 失败: ${error.message}`))
  })

  child.on('exit', code => {
    if (code !== 0) {
      const details = stderr.trim() || stdout.trim() || `exit code ${code}`
      child.emit('probe-error', new Error(`${binary} 提前退出: ${details}`))
    }
  })

  return child
}

/**
 * @param {ProbeNode} node
 * @param {number} localPort
 * @param {{ debug: boolean, logger: (message: string) => void }} options
 */
async function prepareProxyRuntime(node, localPort, options) {
  const binary = node.binary ?? (node.type === 'ss' ? 'ss-local' : 'ssr-local')
  const executable = basename(binary).toLowerCase()

  if (executable === 'sslocal' || executable === 'sslocal.exe') {
    if (node.type !== 'ss') {
      throw new Error('sslocal 目前只按 ss 节点方式适配，ssr 请继续使用 ssr-local')
    }

    return {
      binary,
      args: [
        '-b', `127.0.0.1:${localPort}`,
        '-s', `${node.server}:${node.port}`,
        '-m', node.method,
        '-k', node.password,
      ],
      logOutput(stream, text) {
        logChildOutput(options.logger, stream, text)
      },
      async cleanup() {},
    }
  }

  if (executable === 'ssr-client' || executable === 'ssr-client.exe') {
    if (node.type !== 'ssr') {
      throw new Error('ssr-client 仅用于 ssr 节点')
    }

    if (!node.protocol || !node.obfs) {
      throw new Error(`SSR 节点缺少 protocol 或 obfs: ${node.name}`)
    }

    const defaultConfigPath = join(dirname(binary), 'config.json')
    const defaultConfig = await loadSsrClientTemplate(defaultConfigPath, options.logger)
    const configText = `${JSON.stringify(defaultConfig, null, 2)}\n`
    const configuredPort = resolveSsrClientListenPort(defaultConfig)
    options.logger(`using ssr-client default config at ${defaultConfigPath}`)

    return {
      binary,
      args: [],
      localPort: configuredPort,
      debugConfigPath: defaultConfigPath,
      debugConfigText: configText,
      logOutput(stream, text) {
        logChildOutput(options.logger, stream, text)
      },
      async cleanup() {},
    }
  }

  const args = [
    '-s', node.server,
    '-p', String(node.port),
    '-l', String(localPort),
    '-m', node.method,
    '-k', node.password,
  ]

  if (node.type === 'ssr') {
    if (!node.protocol || !node.obfs) {
      throw new Error(`SSR 节点缺少 protocol 或 obfs: ${node.name}`)
    }

    args.push('-O', node.protocol, '-o', node.obfs)

    if (node.protocolParam) {
      args.push('-G', node.protocolParam)
    }

    if (node.obfsParam) {
      args.push('-g', node.obfsParam)
    }
  }

  return {
    binary,
    args,
    logOutput(stream, text) {
      logChildOutput(options.logger, stream, text)
    },
    async cleanup() {},
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
async function waitForProxyReady(child, localPort, timeoutMs, logger = () => {}) {
  let settled = false

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    child.once('probe-error', error => {
      if (!settled) {
        settled = true
        logger(`startup failed before timeout: ${formatError(error)}`)
        reject(error)
      }
    })

    child.once('exit', code => {
      if (!settled && code === 0) {
        settled = true
        logger('proxy exited cleanly during startup wait')
        reject(new Error('本地代理在启动阶段提前退出'))
      }
    })

    const poll = async () => {
      while (!settled) {
        const ready = await canConnect(localPort)
        if (ready) {
          settled = true
          logger(`local proxy port 127.0.0.1:${localPort} is ready`)
          resolve(undefined)
          return
        }

        if (Date.now() >= deadline) {
          settled = true
          logger(`startup wait elapsed after ${timeoutMs}ms, local port 127.0.0.1:${localPort} is still not ready`)
          reject(new Error(`本地代理端口未就绪: 127.0.0.1:${localPort}`))
          return
        }

        await sleep(200)
      }
    }

    poll().catch(error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

/**
 * @param {number} localPort
 * @param {string} targetUrl
 * @param {number} timeoutSeconds
 */
async function runCurlProbe(localPort, targetUrl, timeoutSeconds, logger = () => {}) {
  const nullDevice = platform() === 'win32' ? 'NUL' : '/dev/null'
  const args = [
    '--silent',
    '--show-error',
    '--fail',
    '--output', nullDevice,
    '--proxy', `socks5h://127.0.0.1:${localPort}`,
    '--max-time', String(timeoutSeconds),
    targetUrl,
  ]
  logger(`curl args: ${args.join(' ')}`)

  const child = spawn('curl', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  let stdout = ''
  child.stdout?.on('data', chunk => {
    const text = chunk.toString()
    stdout += text
    logProcessOutput(logger, 'curl', 'stdout', text)
  })
  child.stderr?.on('data', chunk => {
    const text = chunk.toString()
    stderr += text
    logProcessOutput(logger, 'curl', 'stderr', text)
  })

  const [code] = /** @type {[number | null, NodeJS.Signals | null]} */ (await once(child, 'exit'))
  logger(`curl exit code: ${String(code)}`)
  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `curl exit code ${code}`)
  }
}

async function getFreePort() {
  const { createServer } = await import('node:net')

  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配本地端口'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

/**
 * @param {unknown} error
 */
function formatError(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

/**
 * @param {(message: string) => void} logger
 * @param {'stdout' | 'stderr'} stream
 * @param {string} text
 */
function logChildOutput(logger, stream, text) {
  logProcessOutput(logger, 'proxy', stream, text)
}

/**
 * @param {(message: string) => void} logger
 * @param {'proxy' | 'curl'} processName
 * @param {'stdout' | 'stderr'} stream
 * @param {string} text
 */
function logProcessOutput(logger, processName, stream, text) {
  const trimmed = text.replace(/\r/g, '').trim()
  if (!trimmed) {
    return
  }

  for (const line of trimmed.split('\n')) {
    logger(`${processName} ${stream}: ${line}`)
  }
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function canConnect(port) {
  return await new Promise(resolve => {
    const socket = new Socket()
    let settled = false

    const finish = success => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(success)
    }

    socket.setTimeout(200)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1')
  })
}

/**
 * @param {string} defaultConfigPath
 * @param {(message: string) => void} logger
 */
async function loadSsrClientTemplate(defaultConfigPath, logger) {
  try {
    const raw = await readFile(defaultConfigPath, 'utf8')
    const parsed = JSON.parse(raw)
    logger(`loaded ssr-client default config template from ${defaultConfigPath}`)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch (error) {
    logger(`default ssr-client config not used: ${formatError(error)}`)
    return {}
  }
}

/**
 * @param {Record<string, unknown>} config
 */
function resolveSsrClientListenPort(config) {
  const clientSettings = config.client_settings
  if (clientSettings && typeof clientSettings === 'object') {
    const listenPort = /** @type {Record<string, unknown>} */ (clientSettings).listen_port
    if (typeof listenPort === 'number' && Number.isInteger(listenPort) && listenPort > 0) {
      return listenPort
    }
  }

  return 1080
}
