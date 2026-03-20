import { resolve } from 'node:path'
import { loadNodes } from './config.mjs'
import { createMonitor } from './monitor.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configFile = resolve(process.cwd(), args.config)
  const nodes = await loadNodes(configFile)

  if (nodes.length === 0) {
    console.log('没有可监控的节点')
    process.exitCode = 1
    return
  }

  const monitor = createMonitor(nodes, {
    host: args.host,
    port: args.port,
    intervalSeconds: args.intervalSeconds,
    concurrency: args.concurrency,
    failureThreshold: args.failureThreshold,
    targetUrl: args.targetUrl,
    startupTimeoutMs: args.startupTimeoutMs,
    requestTimeoutSeconds: args.requestTimeoutSeconds,
    telegramBotToken: args.telegramBotToken,
    telegramChatId: args.telegramChatId,
    telegramProxy: args.telegramProxy,
  })

  const snapshot = await monitor.start()
  console.log(`监控已启动: ${snapshot.server.origin}`)
  console.log(`轮询间隔: ${snapshot.settings.intervalSeconds} 秒`)
  console.log(`并发数: ${snapshot.settings.concurrency}`)
  console.log(`失败阈值: ${snapshot.settings.failureThreshold} 次`)
  if (snapshot.settings.telegramEnabled) {
    console.log('Telegram 通知: 已启用')
    if (snapshot.settings.telegramProxy) {
      console.log(`Telegram 代理: ${snapshot.settings.telegramProxy}`)
    }
  }
  console.log(`按 Ctrl+C 停止服务`)

  const shutdown = async () => {
    console.log('\n正在停止监控服务...')
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

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    config: 'nodes.json',
    host: '127.0.0.1',
    port: 3456,
    intervalSeconds: 30,
    concurrency: 4,
    failureThreshold: 3,
    targetUrl: 'https://www.gstatic.com/generate_204',
    startupTimeoutMs: 4000,
    requestTimeoutSeconds: 10,
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
      case '--host':
        options.host = nextValue
        index += 1
        break
      case '--port':
        options.port = Number(nextValue)
        index += 1
        break
      case '--interval':
        options.intervalSeconds = Number(nextValue)
        index += 1
        break
      case '--concurrency':
        options.concurrency = Number(nextValue)
        index += 1
        break
      case '--failure-threshold':
        options.failureThreshold = Number(nextValue)
        index += 1
        break
      case '--target':
        options.targetUrl = nextValue
        index += 1
        break
      case '--startup-timeout':
        options.startupTimeoutMs = Number(nextValue)
        index += 1
        break
      case '--request-timeout':
        options.requestTimeoutSeconds = Number(nextValue)
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
  pnpm monitor --config ./nodes.json

Options:
  --config <file>            节点配置文件
  --host <host>              仪表盘监听地址
  --port <port>              仪表盘监听端口
  --interval <sec>           轮询间隔秒数
  --concurrency <num>        并发探测数
  --failure-threshold <num>  连续失败达到多少次后才告警
  --target <url>             探测目标 URL
  --startup-timeout <ms>     本地代理启动等待时间
  --request-timeout <sec>    curl 请求超时
  --telegram-bot-token <v>   Telegram Bot Token
  --telegram-chat-id <v>     Telegram Chat ID
  --telegram-proxy <url>     Telegram 专用代理，默认 http://127.0.0.1:7897
`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
