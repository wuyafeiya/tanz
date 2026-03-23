# 节点可连接性探测器

只做一件事: 检测 `ss` 节点当前能否正常连接。

## 原理

每个节点执行以下流程:

1. 启动本地 `ss-local`
2. 在本地打开一个临时 SOCKS5 端口
3. 用 `curl` 通过这个 SOCKS5 代理请求固定 URL
4. 请求成功则输出 `UP`，失败则输出 `DOWN`

这比单纯探测端口更准确，因为它实际验证了代理链路。

## 前置条件

- Node.js 24+
- 本机已安装 `curl`
- 本机已安装 `ss-local`

如果二进制不在 PATH 中，可以在节点配置里通过 `binary` 字段写绝对路径。

## 使用

复制示例配置并填入真实节点:

```bash
cp nodes.example.json nodes.json
```

运行探测:

```bash
pnpm probe --config ./nodes.json
```

启动持续监控和本地仪表盘:

```bash
pnpm monitor --config ./nodes.json --interval 8 --port 3456
```

启用并发探测、失败阈值去抖和 Telegram 通知:

```bash
pnpm monitor --config ./nodes.json --interval 8 --concurrency 8 --failure-threshold 3 --telegram-bot-token <token> --telegram-chat-id <chatId>
```

也可以通过环境变量提供 Telegram 配置:

```bash
export TELEGRAM_BOT_TOKEN=xxx
export TELEGRAM_CHAT_ID=123456789
export TELEGRAM_PROXY=http://127.0.0.1:7897
pnpm monitor --config ./nodes.json
```

启动后在浏览器打开:

```text
http://127.0.0.1:3456
```

也可以指定目标地址与超时:

```bash
pnpm probe --config ./nodes.json --target https://www.gstatic.com/generate_204 --startup-timeout 5000 --request-timeout 10
```

输出示例:

```text
HK SS 01    UP
SG SS 02    DOWN    curl: (28) Connection timed out after 10002 milliseconds
```

监控模式能力:

- 持续轮询节点状态
- 支持把多个节点归到同一个站点下统一展示
- 并发探测，加快大批量节点轮询速度
- 单节点失败后会在当前轮次内快速重试，不必等下一次全局轮询
- 本地实时仪表盘
- 页面内可修改轮询间隔
- 手动触发立即探测
- 页面内可一键发送 Telegram 测试消息
- 节点掉线时可使用浏览器通知提醒
- 连续失败达到阈值后再告警，避免短暂抖动误报
- 只有当某个站点下所有节点都不可用时，才会触发站点级告警
- 支持 Telegram 掉线与恢复通知
- Telegram 通知可单独走代理，默认 `http://127.0.0.1:7897`

当前快速重试策略:

- 单个节点一次失败后，会在当前轮次内继续立即重试
- 默认总共尝试 3 次
- 每次重试之间间隔约 0.8 秒
- 不区分首次和重试，每次单独尝试默认都是 2s 启动超时和 8s 请求超时
- 每个节点面板会实时显示当前尝试次数和当前秒表
- 最终结果才会进入本轮状态判断与告警逻辑
- 当某个站点下所有节点都不可用时，会发送一次故障通知
- 故障通知发出后不会暂停站点，仍然继续按正常频率轮询
- 当站点下任意节点恢复可用时，会再发送一次恢复通知

## 配置格式

`ss` 节点:

```json
{
  "id": "hk-ss-01",
  "name": "HK SS 01",
  "siteId": "hk",
  "siteName": "Hong Kong",
  "type": "ss",
  "server": "1.2.3.4",
  "port": 8388,
  "method": "aes-256-gcm",
  "password": "your-password",
  "binary": "ss-local"
}
```

如果你不写 `siteId` / `siteName`，程序会默认把每个节点当成一个独立站点。

## 限制

- 当前不支持从订阅链接自动导入
- 浏览器通知依赖页面授予通知权限

## SSR 单独监控

如果你只有少量 `ssr` 节点，建议不要继续混进主监控，而是单独使用 `mihomo` 常驻测试。

这个仓库现在额外提供了一个独立命令：

```bash
cp ssr-nodes.example.json ssr-nodes.json
pnpm ssr-monitor --config ./ssr-nodes.json
```

它的工作方式是：

1. 启动一个临时 `mihomo` 内核
2. 把 `ssr-nodes.json` 里的 SSR 节点写进配置
3. 通过 Mihomo API 切换当前节点
4. 用 `curl` 走本地 SOCKS5 端口测试目标地址
5. 首次失败时发一次 Telegram，恢复时再发一次 Telegram

最小 SSR 配置示例见 [ssr-nodes.example.json](./ssr-nodes.example.json)。
