import { resolve } from 'node:path'
import { loadNodes } from './config.mjs'
import { probeNode } from './probe.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configFile = resolve(process.cwd(), args.config)
  const nodes = await loadNodes(configFile)

  if (nodes.length === 0) {
    console.log('没有可检测的节点')
    process.exitCode = 1
    return
  }

  let hasFailure = false

  for (const node of nodes) {
    const result = await probeNode(node, {
      targetUrl: args.targetUrl,
      startupTimeoutMs: args.startupTimeoutMs,
      requestTimeoutSeconds: args.requestTimeoutSeconds,
    })

    if (result.ok) {
      console.log(`${result.name}\tUP`)
      continue
    }

    hasFailure = true
    console.log(`${result.name}\tDOWN\t${result.error ?? 'unknown error'}`)
  }

  process.exitCode = hasFailure ? 1 : 0
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    config: 'nodes.example.json',
    targetUrl: 'https://www.gstatic.com/generate_204',
    startupTimeoutMs: 4000,
    requestTimeoutSeconds: 10,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const nextValue = argv[index + 1]

    switch (value) {
      case '--config':
        options.config = nextValue
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
  pnpm probe --config ./nodes.json

Options:
  --config <file>            节点配置文件
  --target <url>             探测目标 URL
  --startup-timeout <ms>     本地代理启动等待时间
  --request-timeout <sec>    curl 请求超时
`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
