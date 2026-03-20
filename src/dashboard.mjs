function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * @param {{ title: string }} options
 */
export function renderDashboardHtml(options) {
  const title = escapeHtml(options.title)

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: oklch(0.97 0.015 85);
        --bg-strong: oklch(0.91 0.04 82);
        --paper: oklch(0.99 0.01 90 / 0.88);
        --ink: oklch(0.28 0.03 40);
        --muted: oklch(0.52 0.03 50);
        --line: oklch(0.82 0.02 70);
        --accent: oklch(0.58 0.16 35);
        --accent-soft: oklch(0.88 0.06 35);
        --ok: oklch(0.68 0.16 150);
        --ok-soft: oklch(0.91 0.05 150);
        --down: oklch(0.62 0.19 28);
        --down-soft: oklch(0.91 0.05 28);
        --warn: oklch(0.74 0.14 82);
        --shadow: 0 24px 80px oklch(0.54 0.03 60 / 0.12);
        --radius: 24px;
        --radius-sm: 16px;
        --content: min(1180px, calc(100vw - 32px));
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        min-height: 100%;
      }

      body {
        font-family: "Avenir Next", "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, oklch(0.9 0.08 80), transparent 28%),
          radial-gradient(circle at 92% 12%, oklch(0.94 0.06 28), transparent 22%),
          linear-gradient(180deg, var(--bg), oklch(0.95 0.02 84));
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(oklch(0.78 0.015 75 / 0.2) 1px, transparent 1px),
          linear-gradient(90deg, oklch(0.78 0.015 75 / 0.18) 1px, transparent 1px);
        background-size: 38px 38px;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.22), transparent 78%);
      }

      .shell {
        width: var(--content);
        margin: 0 auto;
        padding: clamp(24px, 5vw, 56px) 0 64px;
      }

      .masthead {
        display: grid;
        gap: 22px;
        grid-template-columns: 1.3fr 0.9fr;
        align-items: end;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-radius: 999px;
        color: color-mix(in oklch, var(--ink) 74%, var(--accent));
        background: color-mix(in oklch, var(--paper) 74%, var(--accent-soft));
        border: 1px solid color-mix(in oklch, var(--line) 70%, var(--accent));
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      h1 {
        margin: 14px 0 0;
        max-width: 12ch;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
        font-size: clamp(48px, 8vw, 96px);
        line-height: 0.92;
        letter-spacing: -0.05em;
        font-weight: 700;
      }

      .lede {
        margin: 18px 0 0;
        max-width: 58ch;
        color: color-mix(in oklch, var(--ink) 70%, var(--muted));
        font-size: clamp(16px, 2.2vw, 19px);
        line-height: 1.65;
      }

      .control-panel {
        padding: 22px;
        background: linear-gradient(180deg, var(--paper), color-mix(in oklch, var(--paper) 78%, var(--bg-strong)));
        border: 1px solid color-mix(in oklch, var(--line) 75%, var(--accent));
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .control-grid {
        display: grid;
        gap: 14px;
      }

      .label {
        display: grid;
        gap: 8px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: color-mix(in oklch, var(--muted) 72%, var(--ink));
      }

      input, button {
        font: inherit;
      }

      input[type="number"] {
        width: 100%;
        padding: 16px 18px;
        border: 1px solid color-mix(in oklch, var(--line) 72%, var(--accent));
        border-radius: 16px;
        background: color-mix(in oklch, var(--paper) 80%, white);
        color: var(--ink);
      }

      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        cursor: pointer;
        transition: transform 180ms ease, background-color 180ms ease, opacity 180ms ease;
      }

      button:hover {
        transform: translateY(-1px);
      }

      button:disabled {
        cursor: wait;
        opacity: 0.6;
      }

      .primary {
        color: oklch(0.98 0.01 85);
        background: linear-gradient(135deg, var(--accent), color-mix(in oklch, var(--accent) 65%, var(--down)));
      }

      .secondary {
        color: var(--ink);
        background: color-mix(in oklch, var(--paper) 70%, var(--bg-strong));
        border: 1px solid color-mix(in oklch, var(--line) 80%, var(--accent));
      }

      .status-strip {
        margin-top: clamp(30px, 4vw, 48px);
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .stat {
        padding: 18px 0 18px 18px;
        position: relative;
      }

      .stat::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        border-radius: 999px;
        background: color-mix(in oklch, var(--accent) 60%, var(--line));
      }

      .stat strong {
        display: block;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        font-size: clamp(34px, 5vw, 52px);
        line-height: 1;
      }

      .stat span {
        color: var(--muted);
        font-size: 14px;
      }

      .layout {
        margin-top: 24px;
        display: grid;
        gap: 22px;
        grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr);
      }

      .table-wrap, .timeline {
        min-height: 240px;
        background: var(--paper);
        border: 1px solid color-mix(in oklch, var(--line) 75%, var(--accent));
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }

      .table-head, .timeline-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 22px 24px 12px;
      }

      h2 {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        font-size: 28px;
        line-height: 1;
      }

      .meta {
        color: var(--muted);
        font-size: 13px;
      }

      .node-list {
        display: grid;
        gap: 12px;
        padding: 10px 14px 16px;
      }

      .node {
        display: grid;
        gap: 14px;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        padding: 16px 14px;
        border-radius: var(--radius-sm);
        background: color-mix(in oklch, var(--paper) 82%, var(--bg-strong));
        border: 1px solid color-mix(in oklch, var(--line) 78%, var(--accent-soft));
        transform-origin: left center;
        animation: reveal 360ms ease both;
      }

      .node-main {
        display: grid;
        gap: 5px;
      }

      .node-title {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 10px;
      }

      .node-title strong {
        font-size: 18px;
      }

      .node-sub {
        color: var(--muted);
        font-size: 14px;
      }

      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 34px;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 13px;
        color: color-mix(in oklch, var(--ink) 82%, var(--muted));
        background: color-mix(in oklch, var(--paper) 72%, var(--bg-strong));
        border: 1px solid color-mix(in oklch, var(--line) 72%, var(--bg-strong));
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--warn);
        box-shadow: 0 0 0 6px color-mix(in oklch, var(--warn) 15%, transparent);
      }

      .dot.up {
        background: var(--ok);
        box-shadow: 0 0 0 6px color-mix(in oklch, var(--ok) 12%, transparent);
      }

      .dot.down {
        background: var(--down);
        box-shadow: 0 0 0 6px color-mix(in oklch, var(--down) 12%, transparent);
      }

      .state {
        display: grid;
        justify-items: end;
        gap: 8px;
        text-align: right;
      }

      .pill {
        min-width: 92px;
        text-align: center;
        padding: 10px 14px;
        border-radius: 999px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: color-mix(in oklch, var(--ink) 72%, var(--paper));
        background: color-mix(in oklch, var(--warn) 18%, var(--paper));
      }

      .pill.up {
        color: color-mix(in oklch, var(--ok) 46%, var(--ink));
        background: var(--ok-soft);
      }

      .pill.down {
        color: color-mix(in oklch, var(--down) 54%, var(--ink));
        background: var(--down-soft);
      }

      .state small {
        max-width: 28ch;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }

      .timeline-list {
        display: grid;
        gap: 12px;
        padding: 10px 18px 20px;
      }

      .event {
        display: grid;
        gap: 8px;
        padding: 14px 14px 14px 18px;
        border-left: 3px solid color-mix(in oklch, var(--accent) 50%, var(--line));
        background: color-mix(in oklch, var(--paper) 76%, var(--bg-strong));
        border-radius: 0 16px 16px 0;
      }

      .event strong {
        font-size: 14px;
      }

      .event time, .empty, .toast {
        color: var(--muted);
        font-size: 13px;
      }

      .empty {
        padding: 22px 24px 26px;
        line-height: 1.7;
      }

      .footer-note {
        margin-top: 18px;
        color: var(--muted);
        font-size: 13px;
      }

      .toast {
        position: fixed;
        right: 20px;
        bottom: 20px;
        display: inline-flex;
        gap: 8px;
        align-items: center;
        max-width: min(420px, calc(100vw - 40px));
        padding: 14px 16px;
        color: color-mix(in oklch, var(--ink) 78%, var(--paper));
        background: color-mix(in oklch, var(--paper) 50%, var(--bg-strong));
        border: 1px solid color-mix(in oklch, var(--line) 68%, var(--accent));
        border-radius: 18px;
        box-shadow: var(--shadow);
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }

      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }

      @keyframes reveal {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.99);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          scroll-behavior: auto !important;
        }
      }

      @media (max-width: 980px) {
        .masthead, .layout {
          grid-template-columns: 1fr;
        }

        .status-strip {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 680px) {
        .status-strip {
          grid-template-columns: 1fr;
        }

        .node {
          grid-template-columns: 1fr;
        }

        .state {
          justify-items: start;
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="masthead">
        <div>
          <div class="eyebrow">Node Probe Monitor</div>
          <h1>代理连通性持续监控面板</h1>
          <p class="lede">不是一次性跑完就结束，而是把每个节点的状态变化盯住。你可以在页面里调整轮询间隔、手动立即探测，并在节点掉线时收到浏览器通知。</p>
        </div>
        <aside class="control-panel">
          <div class="control-grid">
            <label class="label">
              轮询间隔（秒）
              <input id="interval-input" type="number" min="3" step="1" value="30" />
            </label>
            <div class="button-row">
              <button id="save-button" class="primary">保存频率</button>
              <button id="probe-button" class="secondary">立即探测</button>
              <button id="telegram-test-button" class="secondary">测试 TG</button>
              <button id="notify-button" class="secondary">启用通知</button>
            </div>
            <div class="meta" id="connection-meta">正在连接监控服务…</div>
          </div>
        </aside>
      </section>

      <section class="status-strip" id="status-strip">
        <article class="stat"><strong id="count-total">0</strong><span>总节点数</span></article>
        <article class="stat"><strong id="count-up">0</strong><span>当前可用</span></article>
        <article class="stat"><strong id="count-down">0</strong><span>当前不可用</span></article>
        <article class="stat"><strong id="next-run">-</strong><span>下次轮询</span></article>
      </section>

      <section class="layout">
        <article class="table-wrap">
          <div class="table-head">
            <h2>节点状态</h2>
            <div class="meta" id="cycle-meta">等待首轮探测…</div>
          </div>
          <div class="node-list" id="node-list"></div>
          <div class="empty" id="node-empty" hidden>还没有节点数据。监控服务启动后会先做一轮探测，然后这里会开始展示每个节点的在线状态、最近错误和连续失败次数。</div>
        </article>

        <aside class="timeline">
          <div class="timeline-head">
            <h2>事件时间线</h2>
            <div class="meta" id="alert-meta">仅记录状态变化</div>
          </div>
          <div class="timeline-list" id="timeline-list"></div>
          <div class="empty" id="timeline-empty">暂无状态变更。节点从可用变成不可用，或从不可用恢复时，这里会留下时间线记录。</div>
        </aside>
      </section>

      <p class="footer-note" id="footer-note">目标地址、超时与当前监听地址将由后端配置提供。</p>
    </main>

    <div class="toast" id="toast"></div>

    <script>
      const intervalInput = document.getElementById('interval-input')
      const saveButton = document.getElementById('save-button')
      const probeButton = document.getElementById('probe-button')
      const telegramTestButton = document.getElementById('telegram-test-button')
      const notifyButton = document.getElementById('notify-button')
      const connectionMeta = document.getElementById('connection-meta')
      const cycleMeta = document.getElementById('cycle-meta')
      const nodeList = document.getElementById('node-list')
      const nodeEmpty = document.getElementById('node-empty')
      const timelineList = document.getElementById('timeline-list')
      const timelineEmpty = document.getElementById('timeline-empty')
      const countTotal = document.getElementById('count-total')
      const countUp = document.getElementById('count-up')
      const countDown = document.getElementById('count-down')
      const nextRun = document.getElementById('next-run')
      const footerNote = document.getElementById('footer-note')
      const alertMeta = document.getElementById('alert-meta')
      const toast = document.getElementById('toast')

      /** @type {Map<string, boolean>} */
      const lastNodeAlertState = new Map()
      let toastTimer = null
      let latestSnapshot = null
      let nextRunTicker = null

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

      function formatRelative(value) {
        if (!value) return '未计划'
        const date = new Date(value)
        if (Number.isNaN(date.getTime())) return '未计划'
        const diff = Math.max(0, Math.round((date.getTime() - Date.now()) / 1000))
        if (diff <= 1) return '即将执行'
        return diff + ' 秒后'
      }

      function renderNextRun() {
        if (!latestSnapshot) {
          nextRun.textContent = '-'
          return
        }

        if (latestSnapshot.cycle.running) {
          nextRun.textContent = '进行中'
          return
        }

        nextRun.textContent = formatRelative(latestSnapshot.cycle.nextRunAt)
      }

      function ensureNextRunTicker() {
        if (nextRunTicker) {
          return
        }

        nextRunTicker = setInterval(() => {
          renderNextRun()
        }, 1000)
      }

      function showToast(message) {
        toast.textContent = message
        toast.classList.add('show')
        if (toastTimer) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2600)
      }

      async function postJson(url, body) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          throw new Error(payload.error || ('请求失败: ' + response.status))
        }

        return await response.json().catch(() => ({}))
      }

      function nodeStatusLabel(status) {
        switch (status) {
          case 'up': return 'UP'
          case 'down': return 'DOWN'
          case 'running': return 'RUNNING'
          default: return 'IDLE'
        }
      }

      function nodeStatusClass(status) {
        return status === 'up' || status === 'down' ? status : ''
      }

      function renderNodes(nodes) {
        nodeList.innerHTML = ''
        nodeEmpty.hidden = nodes.length > 0

        for (const node of nodes) {
          const item = document.createElement('article')
          item.className = 'node'

          const errorText = node.lastError
            ? '最近错误：' + node.lastError
            : node.lastCheckedAt
              ? '最近一次探测正常'
              : '等待首轮探测'

          item.innerHTML = \`
            <div class="node-main">
              <div class="node-title">
                <strong>\${node.name}</strong>
                <span class="meta">\${node.type.toUpperCase()} · \${node.server}:\${node.port}</span>
              </div>
              <div class="node-sub">\${errorText}</div>
              <div class="badges">
                <span class="badge"><span class="dot \${nodeStatusClass(node.status)}"></span>连续失败 \${node.consecutiveFailures} 次</span>
                <span class="badge">最近耗时 \${node.lastDurationMs ?? '-'} ms</span>
                <span class="badge">最后探测 \${formatDateTime(node.lastCheckedAt)}</span>
              </div>
            </div>
            <div class="state">
              <div class="pill \${nodeStatusClass(node.status)}">\${nodeStatusLabel(node.status)}</div>
              <small>最近恢复：\${formatDateTime(node.lastOkAt)}</small>
            </div>
          \`
          nodeList.appendChild(item)

          const previousAlertActive = lastNodeAlertState.get(node.id)
          if (node.alertActive && previousAlertActive === false) {
            notifyNodeDown(node)
          }
          lastNodeAlertState.set(node.id, node.alertActive)
        }
      }

      function renderAlerts(alerts) {
        timelineList.innerHTML = ''
        timelineEmpty.hidden = alerts.length > 0
        alertMeta.textContent = alerts.length > 0 ? '最近 ' + alerts.length + ' 条事件' : '仅记录状态变化'

        for (const alert of alerts) {
          const item = document.createElement('article')
          item.className = 'event'
          item.innerHTML = \`
            <strong>\${alert.title}</strong>
            <div>\${alert.message}</div>
            <time>\${formatDateTime(alert.at)}</time>
          \`
          timelineList.appendChild(item)
        }
      }

      function renderState(snapshot) {
        latestSnapshot = snapshot
        const { summary, cycle, settings, nodes, alerts, server } = snapshot
        intervalInput.value = String(settings.intervalSeconds)
        countTotal.textContent = String(summary.total)
        countUp.textContent = String(summary.up)
        countDown.textContent = String(summary.down)
        renderNextRun()
        cycleMeta.textContent = cycle.running
          ? '当前正在执行一轮探测…'
          : '上次完成于 ' + formatDateTime(cycle.lastCompletedAt)
        footerNote.textContent = '监听 ' + server.origin + ' · 目标 ' + settings.targetUrl + ' · 启动超时 ' + settings.startupTimeoutMs + 'ms · 请求超时 ' + settings.requestTimeoutSeconds + 's · 并发 ' + settings.concurrency + ' · 告警阈值 ' + settings.failureThreshold + ' 次' + (settings.telegramEnabled ? ' · Telegram 已启用' : '')
        renderNodes(nodes)
        renderAlerts(alerts)
      }

      function notifyNodeDown(node) {
        const message = node.name + ' 当前不可用'
        showToast(message)

        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('节点掉线告警', {
            body: message,
            tag: 'node-down-' + node.id,
          })
        }
      }

      async function hydrate() {
        const response = await fetch('/api/state')
        if (!response.ok) {
          throw new Error('无法读取初始状态')
        }
        const data = await response.json()
        renderState(data)
      }

      function connectEvents() {
        const source = new EventSource('/api/events')
        source.onopen = () => {
          connectionMeta.textContent = '实时连接已建立'
        }
        source.onmessage = event => {
          const payload = JSON.parse(event.data)
          renderState(payload)
        }
        source.onerror = () => {
          connectionMeta.textContent = '实时连接中断，正在自动重连…'
        }
      }

      saveButton.addEventListener('click', async () => {
        const intervalSeconds = Number(intervalInput.value)
        if (!Number.isInteger(intervalSeconds) || intervalSeconds < 3) {
          showToast('轮询间隔至少为 3 秒')
          return
        }

        saveButton.disabled = true
        try {
          await postJson('/api/settings', { intervalSeconds })
          showToast('轮询频率已更新')
        }
        catch (error) {
          showToast(error instanceof Error ? error.message : String(error))
        }
        finally {
          saveButton.disabled = false
        }
      })

      probeButton.addEventListener('click', async () => {
        probeButton.disabled = true
        try {
          await postJson('/api/probe', {})
          showToast('已触发立即探测')
        }
        catch (error) {
          showToast(error instanceof Error ? error.message : String(error))
        }
        finally {
          probeButton.disabled = false
        }
      })

      telegramTestButton.addEventListener('click', async () => {
        telegramTestButton.disabled = true
        try {
          await postJson('/api/telegram-test', {})
          showToast('测试消息已发送')
        }
        catch (error) {
          showToast(error instanceof Error ? error.message : String(error))
        }
        finally {
          telegramTestButton.disabled = false
        }
      })

      notifyButton.addEventListener('click', async () => {
        if (!('Notification' in window)) {
          showToast('当前浏览器不支持桌面通知')
          return
        }

        const permission = await Notification.requestPermission()
        if (permission === 'granted') {
          showToast('浏览器通知已启用')
        }
        else {
          showToast('通知权限未授予')
        }
      })

      hydrate().catch(error => {
        connectionMeta.textContent = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        ensureNextRunTicker()
        connectEvents()
      })
    </script>
  </body>
</html>`
}
