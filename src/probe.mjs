import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

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
 */

/**
 * @param {ProbeNode} node
 * @param {{ targetUrl?: string, startupTimeoutMs?: number, requestTimeoutSeconds?: number }} [options]
 * @returns {Promise<ProbeResult>}
 */
export async function probeNode(node, options = {}) {
  const targetUrl = options.targetUrl ?? DEFAULT_TARGET_URL
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const requestTimeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS
  const localPort = await getFreePort()
  const startedAt = Date.now()
  const runtime = await prepareProxyRuntime(node, localPort)

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child

  try {
    child = spawnLocalProxy(runtime)
    await waitForProxyReady(child, startupTimeoutMs)
    await runCurlProbe(localPort, targetUrl, requestTimeoutSeconds)

    return {
      nodeId: node.id,
      name: node.name,
      ok: true,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    }
  }
  catch (error) {
    return {
      nodeId: node.id,
      name: node.name,
      ok: false,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: formatError(error),
    }
  }
  finally {
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(800)]).catch(() => {})
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }

    await runtime.cleanup()
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
    stdout += chunk.toString()
  })

  child.stderr?.on('data', chunk => {
    stderr += chunk.toString()
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
 */
async function prepareProxyRuntime(node, localPort) {
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

    const tempDir = await mkdtemp(join(tmpdir(), 'node-probe-ssr-'))
    const configPath = join(tempDir, 'config.json')
    const config = {
      password: node.password,
      method: node.method,
      protocol: node.protocol,
      protocol_param: node.protocolParam ?? '',
      obfs: node.obfs,
      obfs_param: node.obfsParam ?? '',
      udp: true,
      idle_timeout: 300,
      connect_timeout: 6,
      udp_timeout: 6,
      server_settings: {
        listen_address: '0.0.0.0',
        listen_port: node.port,
      },
      client_settings: {
        server: node.server,
        server_port: node.port,
        listen_address: '127.0.0.1',
        listen_port: localPort,
      },
      over_tls_settings: {
        enable: false,
        server_domain: 'goodsitesample.com',
        path: '/udg151df/',
        root_cert_file: '',
      },
    }

    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    return {
      binary,
      args: ['-c', configPath],
      async cleanup() {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      },
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
    async cleanup() {},
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 */
async function waitForProxyReady(child, timeoutMs) {
  let settled = false

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(undefined)
      }
    }, timeoutMs)

    child.once('probe-error', error => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
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
async function runCurlProbe(localPort, targetUrl, timeoutSeconds) {
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
