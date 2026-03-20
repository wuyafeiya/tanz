import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { renderDashboardHtml } from './dashboard.mjs'
import { probeNode } from './probe.mjs'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3456
const DEFAULT_INTERVAL_SECONDS = 30
const DEFAULT_CONCURRENCY = 4
const DEFAULT_FAILURE_THRESHOLD = 3
const MAX_ALERTS = 30

/**
 * @typedef {import('./config.mjs').ProbeNode} ProbeNode
 */

/**
 * @param {ProbeNode[]} nodes
 * @param {{ host?: string, port?: number, intervalSeconds?: number, concurrency?: number, failureThreshold?: number, targetUrl?: string, startupTimeoutMs?: number, requestTimeoutSeconds?: number, telegramBotToken?: string, telegramChatId?: string, telegramProxy?: string }} options
 */
export function createMonitor(nodes, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const html = renderDashboardHtml({ title: 'Node Probe Monitor' })
  const telegram = createTelegramNotifier(options.telegramBotToken, options.telegramChatId, options.telegramProxy)

  let intervalSeconds = normalizeInterval(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
  let concurrency = normalizePositiveInt(options.concurrency ?? DEFAULT_CONCURRENCY, '并发数')
  let failureThreshold = normalizePositiveInt(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD, '失败阈值')
  let revision = 0
  let cycleTimer
  let isRunning = false
  const eventClients = new Set()

  const state = {
    startedAt: new Date().toISOString(),
    settings: {
      intervalSeconds,
      concurrency,
      failureThreshold,
      targetUrl: options.targetUrl,
      startupTimeoutMs: options.startupTimeoutMs,
      requestTimeoutSeconds: options.requestTimeoutSeconds,
      telegramEnabled: telegram.enabled,
      telegramProxy: telegram.proxy,
      telegramDebug: telegram.debug,
    },
    cycle: {
      running: false,
      lastStartedAt: undefined,
      lastCompletedAt: undefined,
      nextRunAt: undefined,
    },
    summary: {
      total: nodes.length,
      up: 0,
      down: 0,
    },
    nodes: nodes.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type,
      server: node.server,
      port: node.port,
      status: 'idle',
      consecutiveFailures: 0,
      alertActive: false,
      lastCheckedAt: undefined,
      lastOkAt: undefined,
      lastDurationMs: undefined,
      lastError: undefined,
      lastAlertAt: undefined,
    })),
    alerts: [],
    telegram: {
      enabled: telegram.enabled,
      proxy: telegram.proxy,
      botTokenHint: telegram.botTokenHint,
      chatIdHint: telegram.chatIdHint,
      lastTestAt: undefined,
      lastTestOk: undefined,
      lastTestError: undefined,
      lastResponseSnippet: undefined,
    },
    server: {
      host,
      port,
      origin: '',
    },
  }

  const server = createServer(async (request, response) => {
    const { method = 'GET', url = '/' } = request
    const pathname = new URL(url, 'http://localhost').pathname

    try {
      if (method === 'GET' && pathname === '/') {
        respondHtml(response, html)
        return
      }

      if (method === 'GET' && pathname === '/api/state') {
        respondJson(response, 200, snapshot())
        return
      }

      if (method === 'GET' && pathname === '/api/events') {
        openEventStream(response)
        return
      }

      if (method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(request)

        if (body.intervalSeconds !== undefined) {
          intervalSeconds = normalizeInterval(body.intervalSeconds)
          state.settings.intervalSeconds = intervalSeconds
        }

        if (body.concurrency !== undefined) {
          concurrency = normalizePositiveInt(body.concurrency, '并发数')
          state.settings.concurrency = concurrency
        }

        if (body.failureThreshold !== undefined) {
          failureThreshold = normalizePositiveInt(body.failureThreshold, '失败阈值')
          state.settings.failureThreshold = failureThreshold
        }

        planNextRun(intervalSeconds * 1000)
        publish()
        respondJson(response, 200, snapshot())
        return
      }

      if (method === 'POST' && pathname === '/api/probe') {
        void runCycle()
        respondJson(response, 202, { accepted: true })
        return
      }

      if (method === 'POST' && pathname === '/api/telegram-test') {
        if (!telegram.enabled) {
          respondJson(response, 400, { error: 'Telegram 未启用，请先配置 bot token 和 chat id' })
          return
        }

        const alert = createAlert(
          'test',
          'Telegram 测试消息',
          `来自 ${host}:${state.server.port} 的监控测试消息。`,
        )
        const result = await sendTelegramAlert(telegram, alert)
        state.telegram.lastTestAt = new Date().toISOString()
        state.telegram.lastTestOk = true
        state.telegram.lastTestError = undefined
        state.telegram.lastResponseSnippet = result.responseSnippet
        publish()
        respondJson(response, 200, { ok: true, responseSnippet: result.responseSnippet })
        return
      }

      respondJson(response, 404, { error: 'not found' })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (pathname === '/api/telegram-test') {
        state.telegram.lastTestAt = new Date().toISOString()
        state.telegram.lastTestOk = false
        state.telegram.lastTestError = message
        if (error && typeof error === 'object' && 'responseSnippet' in error) {
          state.telegram.lastResponseSnippet = String(error.responseSnippet)
        }
        publish()
      }
      respondJson(response, 400, { error: message })
    }
  })

  return {
    async start() {
      await new Promise((resolve, reject) => {
        const handleError = error => {
          server.off('listening', handleListening)
          reject(error)
        }

        const handleListening = () => {
          server.off('error', handleError)
          resolve(undefined)
        }

        server.once('error', handleError)
        server.once('listening', handleListening)
        server.listen(port, host)
      })

      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('无法确定监控服务监听地址')
      }

      state.server.port = address.port
      state.server.origin = `http://${host}:${address.port}`
      publish()
      void runCycle()

      return snapshot()
    },

    async stop() {
      clearTimeout(cycleTimer)

      for (const client of eventClients) {
        client.end()
      }
      eventClients.clear()

      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error)
            return
          }
          resolve(undefined)
        })
      })
    },
  }

  function snapshot() {
    return {
      revision,
      startedAt: state.startedAt,
      settings: { ...state.settings },
      cycle: { ...state.cycle },
      summary: { ...state.summary },
      nodes: state.nodes.map(node => ({ ...node })),
      alerts: state.alerts.map(alert => ({ ...alert })),
      telegram: { ...state.telegram },
      server: { ...state.server },
    }
  }

  function publish() {
    revision += 1
    const data = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const client of eventClients) {
      client.write(data)
    }
  }

  function openEventStream(response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    eventClients.add(response)
    response.on('close', () => {
      eventClients.delete(response)
    })
  }

  async function runCycle() {
    if (isRunning) {
      return
    }

    isRunning = true
    clearTimeout(cycleTimer)
    state.cycle.running = true
    state.cycle.lastStartedAt = new Date().toISOString()
    state.cycle.nextRunAt = undefined
    markNodesRunning()
    publish()

    try {
      const results = await mapWithConcurrency(nodes, concurrency, async (node, index) => {
        const result = await probeNode(node, {
          targetUrl: state.settings.targetUrl,
          startupTimeoutMs: state.settings.startupTimeoutMs,
          requestTimeoutSeconds: state.settings.requestTimeoutSeconds,
        })

        return { index, node, result }
      })

      let up = 0
      let down = 0

      for (const { index, node, result } of results) {
        const current = state.nodes[index]
        const previousStatus = current.status
        current.lastCheckedAt = result.checkedAt
        current.lastDurationMs = result.durationMs

        if (result.ok) {
          current.status = 'up'
          current.lastOkAt = result.checkedAt
          current.lastError = undefined
          current.consecutiveFailures = 0
          up += 1

          if (current.alertActive) {
            current.alertActive = false
            current.lastAlertAt = result.checkedAt
            const alert = createAlert('ok', `${node.name} 已恢复`, `${node.name} 在 ${result.checkedAt} 恢复可用。`)
            pushAlert(alert)
            await sendTelegramAlert(telegram, alert)
          }
          else if (previousStatus === 'down') {
            pushAlert(createAlert('ok', `${node.name} 已恢复`, `${node.name} 在 ${result.checkedAt} 恢复可用。`))
          }

          continue
        }

        current.status = 'down'
        current.lastError = result.error
        current.consecutiveFailures += 1
        down += 1

        if (!current.alertActive && current.consecutiveFailures >= failureThreshold) {
          current.alertActive = true
          current.lastAlertAt = result.checkedAt
          const alert = createAlert(
            'down',
            `${node.name} 掉线`,
            `${node.name} 已连续失败 ${current.consecutiveFailures} 次：${result.error ?? 'unknown error'}`,
          )
          pushAlert(alert)
          await sendTelegramAlert(telegram, alert)
          continue
        }

        if (previousStatus === 'up' || previousStatus === 'running' || previousStatus === 'idle') {
          pushAlert(createAlert(
            'warn',
            `${node.name} 首次失败`,
            `${node.name} 本轮探测失败，但未达到 ${failureThreshold} 次告警阈值。`,
          ))
        }
      }

      state.summary.up = up
      state.summary.down = down
    }
    finally {
      isRunning = false
      state.cycle.running = false
      state.cycle.lastCompletedAt = new Date().toISOString()
      planNextRun(intervalSeconds * 1000)
      publish()
    }
  }

  function markNodesRunning() {
    for (const node of state.nodes) {
      if (node.status === 'idle') {
        node.status = 'running'
      }
    }
  }

  function planNextRun(delayMs) {
    clearTimeout(cycleTimer)
    state.cycle.nextRunAt = new Date(Date.now() + delayMs).toISOString()
    cycleTimer = setTimeout(() => {
      void runCycle()
    }, delayMs)
  }

  function pushAlert(alert) {
    state.alerts.unshift(alert)
    state.alerts = state.alerts.slice(0, MAX_ALERTS)
  }
}

function createAlert(level, title, message) {
  return {
    level,
    title,
    message,
    at: new Date().toISOString(),
  }
}

async function sendTelegramAlert(telegram, alert) {
  if (!telegram.enabled) {
    return { responseSnippet: '' }
  }

  return await telegram.sendMessage(`[${alert.level.toUpperCase()}] ${alert.title}\n${alert.message}\n${alert.at}`)
}

function createTelegramNotifier(botToken, chatId, proxyUrl = 'http://127.0.0.1:7897') {
  if (!botToken || !chatId) {
    return {
      enabled: false,
      proxy: undefined,
      debug: false,
      botTokenHint: undefined,
      chatIdHint: undefined,
      async sendMessage() {},
    }
  }

  return {
    enabled: true,
    proxy: proxyUrl,
    debug: true,
    botTokenHint: maskToken(botToken),
    chatIdHint: maskChatId(chatId),
    async sendMessage(text) {
      const payload = JSON.stringify({
        chat_id: chatId,
        text,
      })

      const args = [
        '--silent',
        '--show-error',
        '--header', 'content-type: application/json',
        '--data', payload,
        `https://api.telegram.org/bot${botToken}/sendMessage`,
      ]

      if (proxyUrl) {
        args.unshift(proxyUrl)
        args.unshift('--proxy')
      }

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
        const error = /** @type {Error & { responseSnippet?: string }} */ (new Error(stderr.trim() || `curl exit code ${code}`))
        error.responseSnippet = stdout.trim().slice(0, 500)
        throw error
      }

      let response
      try {
        response = JSON.parse(stdout)
      }
      catch {
        throw new Error('Telegram 返回了无法解析的响应')
      }

      if (!response.ok) {
        const error = /** @type {Error & { responseSnippet?: string }} */ (new Error(response.description ?? 'unknown telegram error'))
        error.responseSnippet = stdout.trim().slice(0, 500)
        throw error
      }

      return {
        responseSnippet: stdout.trim().slice(0, 500),
      }
    },
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) {
    return []
  }

  const results = new Array(items.length)
  let nextIndex = 0

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  })

  await Promise.all(workers)
  return results
}

function respondHtml(response, html) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request) {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk.toString()
  }

  if (!raw.trim()) {
    return {}
  }

  return JSON.parse(raw)
}

function normalizeInterval(value) {
  const interval = Number(value)
  if (!Number.isInteger(interval) || interval < 3 || interval > 86400) {
    throw new Error('轮询间隔必须是 3 到 86400 之间的整数秒')
  }
  return interval
}

function normalizePositiveInt(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label}必须是正整数`)
  }
  return number
}

function maskToken(value) {
  if (value.length <= 8) {
    return '***'
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function maskChatId(value) {
  const text = String(value)
  if (text.length <= 4) {
    return text
  }
  return `***${text.slice(-4)}`
}
