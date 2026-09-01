# dsh Browser Bridge 用户指南

这是一个自托管的 DSH Desktop 插件。它把当前 DSH 工作区变成一个受保护的 Streamable HTTP MCP 服务，让已经登录的网页版 AI 可以通过 MCP 使用本机工具：读取和搜索项目、应用补丁、执行命令、查询诊断和汇报进度。

项目不提供 AI 模型，也不代理 AI 网站。项目按 MIT 协议开源，没有 Bridge 使用时长或次数收费。模型订阅和 API 费用仍然由对应服务商收取。

[English](README.md)

## 它能做什么

- 在 DSH Desktop 内打开 ChatGPT、Kimi、WorkBuddy、豆包、DeepSeek、文心一言、腾讯元宝等网页入口。
- 使用 Electron `WebContentsView` 嵌入网页，登录状态保存在 `persist:dsh-browser-bridge` 分区。
- 不限制页签数量；可以在单栏浏览，也可以选择两个页签分屏。
- 把当前工作区暴露为受保护的 Streamable HTTP MCP。
- 支持文件列表、读取、搜索、多文件 patch、命令、LSP、诊断和进度工具。
- 支持本机模式、Cloudflare Quick Tunnel、Cloudflare Named Tunnel 和 ngrok。
- 随机 MCP 路径、Bearer Token、命名隧道 Token 保存到操作系统凭据库。
- Bridge 控制入口只允许本机回环访问；网页端不能启动、停止或重置 Bridge。

## 安装

### 方式一：安装 Release 包

从 [Releases](https://github.com/mouzhengsama/dsh-browser-bridge/releases) 下载 `.tgz` 后安装到指定 profile：

```powershell
dsh plugin --profile demo add "C:\path\to\dsh-browser-bridge-1.0.0.tgz"
```

### 方式二：从源码安装

```powershell
git clone https://github.com/mouzhengsama/dsh-browser-bridge.git
cd dsh-browser-bridge
npm install
npm run build
dsh plugin --profile demo add .
```

然后启动：

```powershell
dsh --profile demo
```

把 `demo` 换成你自己的 profile 名称。安装后，DSH 工具列表会出现 `bridge_status`、`bridge_start`、`bridge_stop`、`bridge_reset_path` 和 `bridge_connection_info`。

## 配置

编辑 profile 目录下的 `cordis.patch.yml`。文件不存在就创建；如果已经有一条同 id 配置，请合并到同一条里，不要重复插入。

```yaml
- id: dsh-browser-bridge
  name: '@dsh/browser-bridge'
  config:
    requireBearerToken: true
    allowedOrigins:
      - https://workbuddy.cn
      - https://www.workbuddy.cn
    capabilities:
      read: true
      write: true
      command: true
      lsp: true
      progress: true
    tunnel:
      provider: none
      startupTimeoutMs: 20000
      publicHealthTimeoutMs: 20000
      cloudflaredPath: cloudflared
      ngrokPath: ngrok
    languageServers: []
    persistentMode: true
```

字段含义：

| 配置 | 说明 |
| --- | --- |
| `requireBearerToken` | 强制 MCP 请求带 Bearer Token。除非只做短时间本地调试，否则保持开启。 |
| `allowedOrigins` | 允许跨域访问 MCP 的精确网页 origin。不要使用 `*`。 |
| `capabilities` | 远程工具能力。`write` 和 `command` 风险最高。 |
| `tunnel.provider` | `none` 只允许本机访问；`cloudflare`、`cloudflare-named`、`ngrok` 提供公网入口。 |
| `persistentMode` | DSH 启动后自动启动 Bridge。 |

配置会保存非敏感部分到工作区的 `.dsh-bridge/config.json`。敏感路径和 Token 不会写入这个文件。

## 快速开始

1. 启动 DSH Desktop，进入 Browser Bridge 页面。
2. 点击内置站点按钮，在嵌入浏览器里登录网页 AI。
3. 展开 **Connection Settings**，确认隧道模式。首次使用建议先用 **Local-only**。
4. 点击启动 Bridge，等状态变成 **运行中**。
5. 复制 `mcpUrl` 和 Bearer Token。
6. 在网页 AI 的自定义 MCP / Connector 设置里填入 URL 和 Header。

Header 格式：

```http
Authorization: Bearer <token>
```

## 连接网页 AI

网页 AI 有三种情况：

| 情况 | 做法 | 结果 |
| --- | --- | --- |
| 支持自定义 MCP / Connector | 官方设置里填 Streamable HTTP URL 和 Authorization Header。 | 最稳定。 |
| 支持 Agent 和终端，能访问外网 | 新开对话，第一句粘贴 MCP 地址和连接要求。 | 取决于该产品的执行环境。 |
| 只能普通对话 | 嵌入浏览器里正常使用网页 AI。 | 无法调用本机工具。 |

当前实测结果：

| 站点 | 嵌入浏览器 | MCP 连接 |
| --- | --- | --- |
| Kimi | 可用 | 已实测，走服务端 Streamable HTTP Connector。 |
| ChatGPT | 可用 | 产品策略会变化，请按官方最新 Connector 支持为准。 |
| WorkBuddy | 可用 | Connector 模式需要按当前产品版本再实测。 |
| 豆包、DeepSeek、文心一言、腾讯元宝、智谱清言、天工 AI | 已内置入口 | 未独立验证 MCP 支持。 |
| Arena、Trae、Qwen、Manus、Shunova | 已内置入口 | 未独立验证 MCP 支持。 |

“未独立验证”不代表不能打开或不能登录，只表示项目不声称该站点当前一定支持自定义 MCP。

## 隧道模式

### 本机模式

`tunnel.provider: none` 是默认模式。MCP 只在 `127.0.0.1` 可访问，适合 DSH 里的网页通过 Connector 调用，或同一台电脑上的 MCP 客户端。云端 MCP Connector 访问不到这个地址。

### Cloudflare Quick Tunnel

零账号、零域名配置，每次启动生成新的 `*.trycloudflare.com` 地址。

安装：

```powershell
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
```

在 Bridge 页面选择 **Cloudflare Quick Tunnel** 后启动。适合临时调试，不适合长期固定入口。

### Cloudflare Named Tunnel

适合固定域名。在 Cloudflare 控制台创建远程管理 Tunnel，添加 Published application：

- 公网主机名：例如 `mcp.example.com`
- Service URL：Bridge 显示的 `http://127.0.0.1:<port>`

然后在 Bridge 页面填写相同公网主机名和 Tunnel Token。Token 只保存到操作系统凭据库，不写入 `config.json`。

### ngrok

适合已经有 ngrok 账号和保留域名的用户。先在外部完成安装和认证：

```powershell
winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
ngrok config add-authtoken <token>
```

Bridge 只负责启动 ngrok 子进程，不会把 Authtoken 放进命令行。

## 安全

- MCP URL 里的随机路径和 Bearer Token 都是访问凭证。不要发群、截图、issue 或公开仓库。
- `write` 允许修改文件；`command` 允许执行终端命令。只对可信网页 Agent 开启。
- 公共隧道会把本机工具暴露到公网。最小权限做法是先用 Local-only，再按需开隧道。
- 怀疑泄露时，立刻调用 `bridge_reset_path` 或在 Bridge 页面重置 MCP 地址。
- 本项目不是 AI 官网反代，也不绕过任何网页 AI 的登录、订阅或使用条款。

更完整的安全模型见 [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)。

## 常见问题

### 嵌入浏览器不可用

确认你在 DSH Desktop 里运行。普通 DSH 或非 Electron 宿主会回退到系统浏览器。

### Bridge 显示运行中，但网页 AI 连不上

按顺序检查：

1. 确认网页端填的是完整 `mcpUrl`，不是只有 origin。
2. 确认 Header 是 `Authorization: Bearer <token>`。
3. Local-only 模式下，云端 Connector 访问不到 `127.0.0.1`。需要公网时切换隧道模式。
4. 检查该站是否真的支持自定义 MCP Header 和 Streamable HTTP。
5. 用本地 MCP 客户端完成一次 `initialize` 和 `tools/list`，先确认 Bridge 正常。

### Cloudflare 连不上

`cloudflared` 常用 QUIC / UDP 7844。HTTP 代理通常不生效；必要时使用系统或全局 TUN 代理。

### DSH 更新后插件会坏吗

插件通过命名导出、peerDependencies、可选注入和运行时能力检测适配宿主。如果 DSH 改动很大，优先安装最新的插件 Release；开发文档见 [docs/REAL-E2E.md](docs/REAL-E2E.md)。

## 开发

```powershell
npm install
npm run verify
```

构建包：

```powershell
npm pack
```

本仓库还包含架构决策、真实 DSH Desktop 联调手册、网页 Agent 兼容矩阵和威胁模型。改动 MCP 表面或新增站点入口前请先读对应文档。

## License

MIT。
