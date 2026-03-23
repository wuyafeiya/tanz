import { resolve } from 'node:path'
import { loadSsrNodes } from './ssr-config.mjs'
import { createSsrMonitor } from './ssr-monitor.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configFile = resolve(process.cwd(), args.config)
  const nodes = await loadSsrNodes(configFile)

  if (nodes.length === 0) {
    console.log('没有可监控的 SSR 节点')
    process.exitCode = 1
    return
  }

  const monitor = await createSsrMonitor(nodes, {
    intervalSeconds: args.intervalSeconds,
    requestTimeoutSeconds: args.requestTimeoutSeconds,
    targetUrl: args.targetUrl,
    mihomoBinary: args.mihomoBinary,
    telegramBotToken: args.telegramBotToken,
    telegramChatId: args.telegramChatId,
    telegramProxy: args.telegramProxy,
  })

  const snapshot = await monitor.start()
  console.log('SSR 监控已启动')
  console.log(`mihomo 配置: ${snapshot.configPath}`)
  console.log(`mihomo 可执行文件: ${snapshot.mihomoBinary}`)
  console.log(`本地 SOCKS5: 127.0.0.1:${snapshot.socksPort}`)
  console.log(`控制接口: 127.0.0.1:${snapshot.controllerPort}`)
  console.log(`轮询间隔: ${snapshot.intervalSeconds} 秒`)
  console.log(`请求超时: ${snapshot.requestTimeoutSeconds} 秒`)
  console.log(`目标地址: ${snapshot.targetUrl}`)
  if (snapshot.telegramEnabled) {
    console.log('Telegram 通知: 已启用')
    if (snapshot.telegramProxy) {
      console.log(`Telegram 代理: ${snapshot.telegramProxy}`)
    }
  }
  console.log('按 Ctrl+C 停止 SSR 监控')

  const shutdown = async () => {
    console.log('\n正在停止 SSR 监控...')
    await monitor.stop()
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void shutdown()
  })

  process.once('SIGTERM', () => {
    void shutdown()
  })
}

function parseArgs(argv) {
  const options = {
    config: 'ssr-nodes.json',
    intervalSeconds: 15,
    requestTimeoutSeconds: 8,
    targetUrl: 'https://www.gstatic.com/generate_204',
    mihomoBinary: process.env.MIHOMO_BINARY ?? 'mihomo',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramProxy: process.env.TELEGRAM_PROXY ?? 'http://127.0.0.1:7897',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const nextValue = argv[index + 1]

    switch (value) {
      case '--config':
        options.config = nextValue
        index += 1
        break
      case '--interval':
        options.intervalSeconds = Number(nextValue)
        index += 1
        break
      case '--request-timeout':
        options.requestTimeoutSeconds = Number(nextValue)
        index += 1
        break
      case '--target':
        options.targetUrl = nextValue
        index += 1
        break
      case '--mihomo-binary':
        options.mihomoBinary = nextValue
        index += 1
        break
      case '--telegram-bot-token':
        options.telegramBotToken = nextValue
        index += 1
        break
      case '--telegram-chat-id':
        options.telegramChatId = nextValue
        index += 1
        break
      case '--telegram-proxy':
        options.telegramProxy = nextValue
        index += 1
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`不支持的参数: ${value}`)
    }
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  pnpm ssr-monitor --config ./ssr-nodes.json

Options:
  --config <file>            SSR 节点配置文件
  --interval <sec>           轮询间隔秒数
  --request-timeout <sec>    curl 请求超时
  --target <url>             探测目标 URL
  --mihomo-binary <path>     mihomo 可执行文件路径
  --telegram-bot-token <v>   Telegram Bot Token
  --telegram-chat-id <v>     Telegram Chat ID
  --telegram-proxy <url>     Telegram 专用代理，默认 http://127.0.0.1:7897
`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
