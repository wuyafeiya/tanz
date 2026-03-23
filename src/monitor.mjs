import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { updateNodeServer } from './config.mjs'
import { renderDashboardHtml } from './dashboard.mjs'
import { probeNode } from './probe.mjs'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3456
const DEFAULT_INTERVAL_SECONDS = 8
const DEFAULT_CONCURRENCY = 4
const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 800
const DEFAULT_ATTEMPT_STARTUP_TIMEOUT_MS = 2000
const DEFAULT_ATTEMPT_REQUEST_TIMEOUT_SECONDS = 8
const MAX_ALERTS = 30
const TELEGRAM_ALERT_PHOTO_URL = 'https://www.pkqcloud0.com/favicon.ico'

/**
 * @typedef {import('./config.mjs').ProbeNode} ProbeNode
 */

/**
 * @param {ProbeNode[]} nodes
 * @param {{ configFile?: string, host?: string, port?: number, intervalSeconds?: number, concurrency?: number, failureThreshold?: number, targetUrl?: string, startupTimeoutMs?: number, requestTimeoutSeconds?: number, telegramBotToken?: string, telegramChatId?: string, telegramProxy?: string }} options
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
  const eventClients = new Set()
  const nodeJobs = nodes.map(() => ({
    timer: undefined,
    inFlight: false,
  }))
  const sites = buildSiteDefinitions(nodes)
  let globalCycleTimer = undefined

  const state = {
    startedAt: new Date().toISOString(),
    settings: {
      intervalSeconds,
      concurrency,
      failureThreshold,
      targetUrl: options.targetUrl,
      startupTimeoutMs: DEFAULT_ATTEMPT_STARTUP_TIMEOUT_MS,
      requestTimeoutSeconds: DEFAULT_ATTEMPT_REQUEST_TIMEOUT_SECONDS,
      retryAttempts: DEFAULT_RETRY_ATTEMPTS,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      telegramEnabled: telegram.enabled,
      telegramProxy: telegram.proxy,
      telegramDebug: telegram.debug,
    },
    cycle: {
      running: false,
      lastStartedAt: undefined,
      lastCompletedAt: undefined,
      lastDurationMs: undefined,
      nextRunAt: undefined,
    },
    summary: {
      total: sites.length,
      up: 0,
      down: 0,
    },
    nodes: nodes.map(node => ({
      id: node.id,
      name: node.name,
      siteId: node.siteId,
      siteName: node.siteName,
      type: node.type,
      server: node.server,
      port: node.port,
      resolvedIp: isIP(node.server) ? node.server : undefined,
      resolvedAt: isIP(node.server) ? new Date().toISOString() : undefined,
      resolveError: undefined,
      status: 'idle',
      consecutiveFailures: 0,
      alertActive: false,
      paused: false,
      pauseReason: undefined,
      escalationStage: 0,
      nextRunAt: undefined,
      lastCheckedAt: undefined,
      lastOkAt: undefined,
      lastDurationMs: undefined,
      lastError: undefined,
      lastAlertAt: undefined,
      currentAttempt: 0,
      currentAttemptMax: DEFAULT_RETRY_ATTEMPTS,
      attemptStartedAt: undefined,
    })),
    sites: sites.map(site => ({
      id: site.id,
      name: site.name,
      nodeIds: [...site.nodeIds],
      totalNodes: site.nodeIds.length,
      upNodes: 0,
      downNodes: 0,
      status: 'idle',
      alertActive: false,
      paused: false,
      pauseReason: undefined,
      escalationStage: 0,
      nextCheckAt: undefined,
      lastAlertAt: undefined,
      lastOkAt: undefined,
      lastDownAt: undefined,
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

        rescheduleActiveNodes(intervalSeconds * 1000)
        publish()
        respondJson(response, 200, snapshot())
        return
      }

      if (method === 'POST' && pathname === '/api/probe') {
        triggerImmediateProbeAll()
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

      if (method === 'POST' && pathname === '/api/node-server') {
        if (!options.configFile) {
          respondJson(response, 400, { error: '当前监控未绑定配置文件' })
          return
        }

        const body = await readJsonBody(request)
        const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
        const nextServer = typeof body.server === 'string' ? body.server : ''
        const updated = await updateNodeServer(options.configFile, nodeId, nextServer)
        const index = nodes.findIndex(node => node.id === updated.id)

        if (index < 0) {
          throw new Error(`未找到节点: ${updated.id}`)
        }

        nodes[index].server = updated.server
        const current = state.nodes[index]
        current.server = updated.server
        resetNodeState(index)
        clearSiteTimer(current.siteId)
        scheduleSiteNodes(current.siteId, 0)
        publish()
        respondJson(response, 200, { ok: true, node: { ...state.nodes[index] } })
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

      for (let index = 0; index < state.nodes.length; index += 1) {
        scheduleNode(index, 0)
      }

      publish()
      return snapshot()
    },

    async stop() {
      for (const job of nodeJobs) {
        clearTimeout(job.timer)
      }

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
    syncGlobalState()
    return {
      revision,
      startedAt: state.startedAt,
      settings: { ...state.settings },
      cycle: { ...state.cycle },
      summary: { ...state.summary },
      sites: state.sites.map(site => ({ ...site, nodeIds: [...site.nodeIds] })),
      nodes: state.nodes.map(node => ({ ...node })),
      alerts: state.alerts.map(alert => ({ ...alert })),
      telegram: { ...state.telegram },
      server: { ...state.server },
    }
  }

  function publish() {
    syncGlobalState()
    revision += 1
    const data = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const client of eventClients) {
      client.write(data)
    }
  }

  function syncGlobalState() {
    const running = nodeJobs.some(job => job.inFlight)
    const wasRunning = state.cycle.running
    state.cycle.running = running

    if (!running && wasRunning && state.cycle.lastStartedAt && state.cycle.lastCompletedAt) {
      const startedAt = new Date(state.cycle.lastStartedAt).getTime()
      const completedAt = new Date(state.cycle.lastCompletedAt).getTime()
      if (!Number.isNaN(startedAt) && !Number.isNaN(completedAt) && completedAt >= startedAt) {
        state.cycle.lastDurationMs = completedAt - startedAt
      }
    }

    let nextRunAtMs = Number.POSITIVE_INFINITY
    let up = 0
    let down = 0

    for (const site of state.sites) {
      if (site.status === 'up') {
        up += 1
      }
      else if (site.status === 'down' || site.status === 'paused') {
        down += 1
      }

      if (!site.paused && site.nextCheckAt) {
        const timestamp = new Date(site.nextCheckAt).getTime()
        if (!Number.isNaN(timestamp) && timestamp < nextRunAtMs) {
          nextRunAtMs = timestamp
        }
      }
    }

    state.summary.up = up
    state.summary.down = down
    state.cycle.nextRunAt = Number.isFinite(nextRunAtMs) ? new Date(nextRunAtMs).toISOString() : undefined
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

  function clearNodeTimer(index) {
    clearTimeout(nodeJobs[index].timer)
    nodeJobs[index].timer = undefined
    state.nodes[index].nextRunAt = undefined
    updateSiteNextCheck(state.nodes[index].siteId)
  }

  function clearSiteTimer(siteId) {
    const site = getSiteState(siteId)
    if (site) {
      site.nextCheckAt = undefined
    }
  }

  function scheduleNode(index, delayMs) {
    const current = state.nodes[index]
    const site = getSiteState(current.siteId)
    if (current.paused || site?.paused) {
      clearNodeTimer(index)
      return
    }

    clearNodeTimer(index)
    const runAtMs = Date.now() + delayMs
    current.nextRunAt = new Date(runAtMs).toISOString()
    updateSiteNextCheck(current.siteId)
    nodeJobs[index].timer = setTimeout(() => {
      void runNodeProbe(index, false)
    }, delayMs)
  }

  function rescheduleActiveNodes(delayMs) {
    for (let index = 0; index < state.nodes.length; index += 1) {
      const current = state.nodes[index]
      const site = getSiteState(current.siteId)
      if (nodeJobs[index].inFlight || current.paused || site?.paused) {
        continue
      }
      scheduleNode(index, delayMs)
    }
  }

  function triggerImmediateProbeAll() {
    clearTimeout(globalCycleTimer)
    globalCycleTimer = undefined
    state.cycle.nextRunAt = undefined
    for (const site of state.sites) {
      resetSiteState(site.id)
      scheduleSiteNodes(site.id, 0)
    }
    publish()
  }

  function scheduleSiteNodes(siteId, delayMs) {
    for (const index of getSiteNodeIndexes(siteId)) {
      if (nodeJobs[index].inFlight) {
        continue
      }
      scheduleNode(index, delayMs)
    }
    updateSiteNextCheck(siteId)
  }

  function updateSiteNextCheck(siteId) {
    const site = getSiteState(siteId)
    if (!site) {
      return
    }

    site.nextCheckAt = state.cycle.nextRunAt
  }

  function resetNodeState(index) {
    const current = state.nodes[index]
    current.status = 'idle'
    current.consecutiveFailures = 0
    current.alertActive = false
    current.paused = false
    current.pauseReason = undefined
    current.escalationStage = 0
    current.lastError = undefined
    current.resolvedIp = isIP(current.server) ? current.server : undefined
    current.resolvedAt = isIP(current.server) ? new Date().toISOString() : undefined
    current.resolveError = undefined
    current.currentAttempt = 0
    current.currentAttemptMax = state.settings.retryAttempts
    current.attemptStartedAt = undefined
  }

  function resetSiteState(siteId) {
    const site = getSiteState(siteId)
    if (!site) {
      return
    }

    clearSiteTimer(siteId)
    site.alertActive = false
    site.paused = false
    site.pauseReason = undefined
    site.escalationStage = 0
    site.lastAlertAt = undefined
    site.nextCheckAt = undefined

    for (const index of getSiteNodeIndexes(siteId)) {
      const current = state.nodes[index]
      current.paused = false
      current.pauseReason = undefined
      current.alertActive = false
    }
  }

  function getSiteIndex(siteId) {
    return state.sites.findIndex(site => site.id === siteId)
  }

  function getSiteState(siteId) {
    return state.sites.find(site => site.id === siteId)
  }

  function getSiteNodeIndexes(siteId) {
    /** @type {number[]} */
    const indexes = []
    for (let index = 0; index < state.nodes.length; index += 1) {
      if (state.nodes[index].siteId === siteId) {
        indexes.push(index)
      }
    }
    return indexes
  }

  async function runNodeProbe(index, resumedFromPause) {
    const job = nodeJobs[index]
    const current = state.nodes[index]
    const node = nodes[index]
    const site = getSiteState(current.siteId)

    if (job.inFlight || current.paused || site?.paused) {
      return
    }

    clearNodeTimer(index)
    job.inFlight = true
    if (!state.cycle.running) {
      state.cycle.lastStartedAt = new Date().toISOString()
    }
    publish()

    try {
      await resolveNodeServer(current)
      const result = await probeNodeWithRetry(node, {
        targetUrl: state.settings.targetUrl,
        startupTimeoutMs: state.settings.startupTimeoutMs,
        requestTimeoutSeconds: state.settings.requestTimeoutSeconds,
        retryAttempts: state.settings.retryAttempts,
        retryDelayMs: state.settings.retryDelayMs,
        onAttemptStart(attempt, maxAttempts) {
          current.status = 'running'
          current.currentAttempt = attempt
          current.currentAttemptMax = maxAttempts
          current.attemptStartedAt = new Date().toISOString()
          publish()
        },
        onAttemptFinish() {
          current.attemptStartedAt = undefined
          publish()
        },
      })

      const previousStatus = current.status
      current.lastCheckedAt = result.checkedAt
      current.lastDurationMs = result.durationMs
      current.currentAttempt = 0
      current.currentAttemptMax = state.settings.retryAttempts
      current.attemptStartedAt = undefined

      if (result.ok) {
        current.status = 'up'
        current.lastOkAt = result.checkedAt
        current.lastError = undefined
        current.consecutiveFailures = 0

        await evaluateSiteState(current.siteId, resumedFromPause)
        return
      }

      current.status = 'down'
      current.lastError = result.error
      current.consecutiveFailures += Math.max(1, result.retryAttemptsUsed ?? 1)

      if (previousStatus === 'up' || previousStatus === 'idle') {
        pushAlert(createAlert(
          'warn',
          `${node.name} 首次失败`,
          `${node.name} 本轮探测失败，但未达到 ${failureThreshold} 次告警阈值。`,
        ))
      }

      await evaluateSiteState(current.siteId, resumedFromPause)
    }
    finally {
      job.inFlight = false
      state.cycle.lastCompletedAt = new Date().toISOString()
      maybeScheduleRegularSiteCycle(current.siteId)
      publish()
    }
  }

  async function resolveNodeServer(current) {
    if (isIP(current.server)) {
      current.resolvedIp = current.server
      current.resolvedAt = new Date().toISOString()
      current.resolveError = undefined
      return
    }

    try {
      const records = await lookup(current.server, { all: true })
      const preferred = records.find(record => record.family === 4) ?? records[0]
      current.resolvedIp = preferred?.address
      current.resolvedAt = new Date().toISOString()
      current.resolveError = preferred ? undefined : '未解析到 IP'
    }
    catch (error) {
      current.resolvedIp = undefined
      current.resolvedAt = new Date().toISOString()
      current.resolveError = error instanceof Error ? error.message : String(error)
    }
  }

  async function evaluateSiteState(siteId, resumedFromPause = false) {
    const site = getSiteState(siteId)
    if (!site) {
      return
    }

    const nodeIndexes = getSiteNodeIndexes(siteId)
    const siteNodes = nodeIndexes.map(index => state.nodes[index])
    const upNodes = siteNodes.filter(node => node.status === 'up').length
    const downNodes = siteNodes.filter(node => node.status === 'down' || node.status === 'paused').length
    const runningNodes = siteNodes.filter(node => node.status === 'running').length
    const checkedNodes = siteNodes.filter(node => node.lastCheckedAt).length
    const anyDown = checkedNodes === siteNodes.length && siteNodes.length > 0 && downNodes > 0 && runningNodes === 0
    const allRecovered = checkedNodes === siteNodes.length && siteNodes.length > 0 && downNodes === 0 && runningNodes === 0

    site.upNodes = upNodes
    site.downNodes = downNodes

    if (site.paused) {
      site.status = 'paused'
    }
    else if (runningNodes > 0) {
      site.status = 'running'
    }
    else if (upNodes > 0) {
      site.status = 'up'
      site.lastOkAt = new Date().toISOString()
    }
    else if (downNodes > 0) {
      site.status = 'down'
      site.lastDownAt = new Date().toISOString()
    }
    else {
      site.status = 'idle'
    }

    if (allRecovered) {
      const hadAlert = site.alertActive || resumedFromPause
      if (hadAlert) {
        const alert = createAlert('ok', '站点恢复', buildSiteAlertMessage(site, siteNodes, 'up'))
        pushAlert(alert)
        await sendTelegramAlert(telegram, alert)
      }
      resetSiteState(siteId)
      updateSiteNextCheck(siteId)
      return
    }

    if (anyDown && !site.alertActive) {
      site.alertActive = true
      site.escalationStage = 0
      site.lastAlertAt = new Date().toISOString()
      site.pauseReason = '站点内存在异常节点，继续正常轮询等待恢复'
      const alert = createAlert('down', '站点疑似故障', buildSiteAlertMessage(site, siteNodes, 'down'))
      pushAlert(alert)
      await sendTelegramAlert(telegram, alert)
      return
    }
  }

  function pushAlert(alert) {
    state.alerts.unshift(alert)
    state.alerts = state.alerts.slice(0, MAX_ALERTS)
  }

  function maybeScheduleRegularSiteCycle(siteId) {
    const hasInFlightNode = nodeJobs.some(job => job.inFlight)
    if (hasInFlightNode) {
      return
    }

    const hasRunningNode = state.nodes.some(node => node.status === 'running')
    if (hasRunningNode) {
      return
    }

    if (globalCycleTimer) {
      return
    }

    const runAtMs = Date.now() + intervalSeconds * 1000
    state.cycle.nextRunAt = new Date(runAtMs).toISOString()
    for (const site of state.sites) {
      if (!site.paused) {
        site.nextCheckAt = state.cycle.nextRunAt
      }
    }

    globalCycleTimer = setTimeout(() => {
      globalCycleTimer = undefined
      state.cycle.nextRunAt = undefined
      for (const site of state.sites) {
        if (site.paused) {
          site.nextCheckAt = undefined
          continue
        }
        site.nextCheckAt = undefined
        scheduleSiteNodes(site.id, 0)
      }
      publish()
    }, intervalSeconds * 1000)
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

function buildSiteAlertMessage(site, siteNodes, mode) {
  const targetNode = mode === 'down'
    ? siteNodes.find(node => node.status === 'down' || node.status === 'paused') ?? siteNodes[0]
    : siteNodes.find(node => node.status === 'up') ?? siteNodes[0]
  const targetAddress = targetNode?.resolvedIp ?? targetNode?.server ?? '-'
  return `${site.name}-${targetAddress}`
}

async function sendTelegramAlert(telegram, alert) {
  if (!telegram.enabled) {
    return { responseSnippet: '' }
  }

  const message = buildTelegramMessage(alert)
  if (alert.title === '站点疑似故障' || alert.title === '站点恢复') {
    return await telegram.sendPhoto(TELEGRAM_ALERT_PHOTO_URL, message)
  }

  return await telegram.sendMessage(message)
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
      async sendPhoto() {},
    }
  }

  return {
    enabled: true,
    proxy: proxyUrl,
    debug: true,
    botTokenHint: maskToken(botToken),
    chatIdHint: maskChatId(chatId),
    async sendPhoto(photoUrl, caption) {
      const payload = JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
      })

      return await sendTelegramRequest(botToken, proxyUrl, 'sendPhoto', payload)
    },
    async sendMessage(text) {
      const payload = JSON.stringify({
        chat_id: chatId,
        text,
      })

      return await sendTelegramRequest(botToken, proxyUrl, 'sendMessage', payload)
    },
  }
}

async function sendTelegramRequest(botToken, proxyUrl, method, payload) {
  const args = [
    '--silent',
    '--show-error',
    '--header', 'content-type: application/json',
    '--data-binary', '@-',
    `https://api.telegram.org/bot${botToken}/${method}`,
  ]

  if (proxyUrl) {
    args.unshift(proxyUrl)
    args.unshift('--proxy')
  }

  const child = spawn('curl', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdin?.end(Buffer.from(payload, 'utf8'))

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
}

async function probeNodeWithRetry(node, options) {
  const retryAttempts = Math.max(1, options.retryAttempts)
  const startedAt = Date.now()
  let lastResult

  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    options.onAttemptStart?.(attempt, retryAttempts)
    try {
      lastResult = await probeNode(node, {
        targetUrl: options.targetUrl,
        startupTimeoutMs: options.startupTimeoutMs,
        requestTimeoutSeconds: options.requestTimeoutSeconds,
      })
    }
    finally {
      options.onAttemptFinish?.()
    }

    if (lastResult.ok) {
      return {
        ...lastResult,
        durationMs: Date.now() - startedAt,
        retryAttemptsUsed: attempt,
      }
    }

    if (attempt < retryAttempts) {
      await sleep(options.retryDelayMs)
    }
  }

  return {
    ...lastResult,
    durationMs: Date.now() - startedAt,
    error: lastResult?.error,
    retryAttemptsUsed: retryAttempts,
  }
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

function buildTelegramMessage(alert) {
  if (
    alert.title === '站点疑似故障'
    || alert.title === '站点二次尝试不通'
    || alert.title === '站点故障'
    || alert.title === '站点恢复'
    || alert.title === '节点疑似故障'
    || alert.title === '节点二次尝试不通'
    || alert.title === '节点故障'
    || alert.title === '节点恢复'
  ) {
    return `${alert.title}\n${alert.message}\n${formatChinaTime(alert.at)}`
  }

  if (alert.title === 'Telegram 测试消息') {
    return alert.title
  }

  return `${alert.title}\n${alert.message}`
}

function formatChinaTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`
}

/**
 * @param {ProbeNode[]} nodes
 */
function buildSiteDefinitions(nodes) {
  const map = new Map()

  for (const node of nodes) {
    const existing = map.get(node.siteId)
    if (existing) {
      existing.nodeIds.push(node.id)
      continue
    }

    map.set(node.siteId, {
      id: node.siteId,
      name: node.siteName,
      nodeIds: [node.id],
    })
  }

  return [...map.values()]
}
