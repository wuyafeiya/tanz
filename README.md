# 节点可连接性探测器

只做一件事: 检测 `ss` / `ssr` 节点当前能否正常连接。

## 原理

每个节点执行以下流程:

1. 启动本地 `ss-local` 或 `ssr-local`
2. 在本地打开一个临时 SOCKS5 端口
3. 用 `curl` 通过这个 SOCKS5 代理请求固定 URL
4. 请求成功则输出 `UP`，失败则输出 `DOWN`

这比单纯探测端口更准确，因为它实际验证了代理链路。

## 前置条件

- Node.js 24+
- 本机已安装 `curl`
- 本机已安装:
  - `ss-local`
  - `ssr-local`

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
pnpm monitor --config ./nodes.json --interval 30 --port 3456
```

启用并发探测、失败阈值去抖和 Telegram 通知:

```bash
pnpm monitor --config ./nodes.json --interval 30 --concurrency 8 --failure-threshold 3 --telegram-bot-token <token> --telegram-chat-id <chatId>
```

也可以通过环境变量提供 Telegram 配置:

```bash
export TELEGRAM_BOT_TOKEN=xxx
export TELEGRAM_CHAT_ID=123456789
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
JP SSR 01   DOWN    curl: (28) Connection timed out after 10002 milliseconds
```

监控模式能力:

- 持续轮询节点状态
- 并发探测，加快大批量节点轮询速度
- 本地实时仪表盘
- 页面内可修改轮询间隔
- 手动触发立即探测
- 页面内可一键发送 Telegram 测试消息
- 节点掉线时可使用浏览器通知提醒
- 连续失败达到阈值后再告警，避免短暂抖动误报
- 支持 Telegram 掉线与恢复通知

## 配置格式

`ss` 节点:

```json
{
  "id": "hk-ss-01",
  "name": "HK SS 01",
  "type": "ss",
  "server": "1.2.3.4",
  "port": 8388,
  "method": "aes-256-gcm",
  "password": "your-password",
  "binary": "ss-local"
}
```

`ssr` 节点:

```json
{
  "id": "jp-ssr-01",
  "name": "JP SSR 01",
  "type": "ssr",
  "server": "5.6.7.8",
  "port": 443,
  "method": "aes-256-cfb",
  "password": "your-password",
  "protocol": "auth_sha1_v4",
  "obfs": "tls1.2_ticket_auth",
  "binary": "ssr-local"
}
```

## 限制

- 当前不支持从订阅链接自动导入
- `ssr-local` 参数可能因你使用的实现不同而存在差异，必要时需要调整 [src/probe.mjs](./src/probe.mjs) 里的参数映射
- 浏览器通知依赖页面授予通知权限
