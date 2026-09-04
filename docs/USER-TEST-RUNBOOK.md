# Browser Bridge 真实测试执行手册

面向用户的手册：按顺序在真实 DSH Desktop、真实公网隧道、真实已登录网页 AI 里完成端到端测试。

## 0. 安装并加载插件

1. 在 PowerShell 进入插件源码目录：

   ```powershell
   cd "E:UserDataMy DocumentsChatGPTBrowser Bridge"
   npm install
   npm run verify
   ```

2. 确认 `typecheck`、`test`、`build` 全部通过。
3. 把插件安装到独立测试 profile：

   ```powershell
   dsh plugin --profile browser-bridge-e2e add .
   ```

4. 启动或重启 DSH Desktop，并切换到 `browser-bridge-e2e` profile。
5. 预期结果：DSH 界面出现 Browser Bridge 页面。

如果 DSH 启动后没有 Browser Bridge，优先检查 profile 目录下 `node_modules/@dsh/browser-bridge` 是否存在；不存在就停止 DSH 后重新执行第 3 步。

---

## 1. 在内嵌浏览器登录网页 AI

1. 打开 DSH Desktop，进入 Browser Bridge 页面。
2. 找到「快速打开」折叠区域，展开它。
3. 点击以下站点，用内置浏览器登录你的账号：

| 站点 | 网址 | 说明 |
|------|------|------|
| ChatGPT | chatgpt.com | OpenAI 官方，需订阅才能用 connector |
| Kimi | kimi.moonshot.cn | 长文本专家，20 万字上下文 |
| WorkBuddy | workbuddy.cn/app | 支持 Agent 模式和 MCP connector |
| Manus | manus.im/app | AI Agent 平台 |
| Shunova | shunova.cc | AI 对话平台 |

> 注意：每次新开对话都要重新配置 MCP connector 或粘贴提示词；旧对话不会自动记住。

---

## 2. 本地烟雾测试（不依赖隧道）

在 Bridge 页面确认状态为「运行中」后，用 PowerShell 测试本地健康检查：

```powershell
# 从 Bridge 页面复制 MCP URL 和 Bearer Token
$url = "http://127.0.0.1:<端口>/mcp/<秘密路径>"
$token = "Bearer <your-token>"

# 测试健康检查
Invoke-WebRequest -Uri "$url/health" -Headers @{ "Authorization" = $token } -UseBasicParsing

# 预期：状态码 200，无报错
```

如果本地 health 返回 200，说明 Bridge 服务端运行正常。

---

## 3. 开启写 / 命令能力

Bridge 默认只开读文件能力。要执行写操作和命令，需手动开启：

1. 在 Browser Bridge 页面右上角点「设置」。
2. 找到以下开关，按需开启：

| 开关 | 作用 | 风险 |
|------|------|------|
| 允许写入 | apply_patch、创建文件 | 可误写代码 |
| 允许执行命令 | run_command | 可执行任意 shell 命令 |

3. 保存设置。开启后 MCP 工具可修改本地文件或执行系统命令。

---

## 4. 隧道模式测试

隧道决定 MCP URL 是否能被公网访问。

### 4A. 本机模式（tunnel: none）

适合在同一台机器上测试，或网站支持创建自定义 connector 时使用。

1. 设置 - 隧道模式 - 选择「本机模式」。
2. 点「启动 Bridge」- 状态变为「运行中」。
3. 复制显示的 MCP URL，格式为 `http://127.0.0.1:<端口>/mcp/<秘密路径>`。
4. 只能在本机使用，其他设备无法访问。

### 4B. Cloudflare Quick Tunnel

零配置，临时地址，每次启动都变。适合开发调试。

1. 确保已安装 cloudflared：

   ```powershell
   winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
   cloudflared --version
   ```

2. 设置 - 隧道模式 - 选择「Cloudflare Quick Tunnel」。
3. 点「启动 Bridge」- 等待状态变为「运行中」。
4. 复制 MCP URL，格式为 `https://<随机>.trycloudflare.com/mcp/<秘密路径>`。
5. **注意**：每次重启 Bridge 地址都会变，需要重新在网页 AI 里更新 connector。

> 网络要求：cloudflared 走 QUIC/UDP 7844，需要能访问外网（开系统/全局代理）。

### 4C. Cloudflare Named Tunnel

固定地址，适合长期使用。需要 Cloudflare 账号、域名和 Tunnel Token。

1. 在 Cloudflare Zero Trust 创建远程管理的 Tunnel，复制 Tunnel Token。
2. 添加 Published application：
   - 公网主机名 = 你的域名，例如 `mcp.example.com`
   - Service URL = Bridge 显示的本地地址 `http://127.0.0.1:<端口>`
3. 设置 - 隧道模式 - 选择「Cloudflare Named Tunnel」。
4. 填写公网主机名和 Tunnel Token，点「保存 Named Tunnel」。
5. 点「启动 Bridge」。

### 4D. ngrok 开发域名

固定开发域名，有免费额度（约每月 20,000 次请求）。

1. 安装 ngrok：

   ```powershell
   winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements
   ngrok config add-authtoken <YOUR_AUTHTOKEN>
   ```

2. 在 ngrok 官网保留一个开发域名。
3. 设置 - 隧道模式 - 选择「ngrok 开发域名」。
4. 填入保留域名，点「启动 Bridge」。

---

## 5. 在网页 AI 中配置 MCP Connector

### 方式一：ChatGPT connector（推荐，已测试通过）

1. 在 ChatGPT 网页端进入「Settings - Connectors - Add connection」。
2. 粘贴 MCP URL（HTTPS 地址）。
3. 展开「Advanced」- 勾选「Allow connecting without a header」- 保存。
4. 预期：显示 "Connected"，工具列表出现 Browser Bridge 的工具。

> 注意：ChatGPT 要求 HTTPS URL，不接受 `http://127.0.0.1`。

### 方式二：WorkBuddy Agent 模式（不支持自定义 connector 的网站）

1. 在 DSH 内置浏览器打开 WorkBuddy 并登录。
2. 打开一个新对话。
3. 把 Bridge 页的「复制提示词」整段粘贴进输入框，发送（不要拆开，不要先聊别的）。
4. 提示词内容示例：

   ```
   MCP URL: https://<你的隧道地址>/mcp/<秘密路径>
   Authorization: Bearer <your-token>
   快速连接这个 Streamable HTTP MCP，明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。
   ```

5. 新开对话要重新发一次，旧对话不会记住 MCP。

### 方式三：curl 调试（验证 MCP 协议）

```bash
# 测试 initialize
curl -X POST "https://<mcp-url>" ^
  -H "Authorization: Bearer <token>" ^
  -H "Content-Type: application/json" ^
  -d "{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}"

# 测试 tools/list
curl -X POST "https://<mcp-url>" ^
  -H "Authorization: Bearer <token>" ^
  -H "Content-Type: application/json" ^
  -d "{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"
```

---

## 6. 端到端工具回归测试

在网页 AI 里按顺序测试以下工具，从低风险到高风险：

### 6.1 bridge_info（最低风险）
询问网页 AI：「调用 bridge_info 工具，查看 Bridge 信息」

预期返回：MCP URL、隧道类型、工具列表等。

### 6.2 list_files
「调用 list_files，列出 E:/UserData/My Documents/ChatGPT/Browser Bridge/src 目录的文件」

预期：返回该目录下的文件列表。

### 6.3 search_text
「在当前项目目录搜索包含 'MCP' 的文件」

预期：返回匹配的文件路径和行号。

### 6.4 read_file
「读取 E:/UserData/My Documents/ChatGPT/Browser Bridge/package.json 的内容」

预期：返回文件内容。

### 6.5 apply_patch（需开启「允许写入」）
「在当前目录新建一个测试文件 test-patch.txt，内容为 'Browser Bridge 集成测试'」

预期：文件被创建，确认文件存在。

### 6.6 run_command（需开启「允许执行命令」）
「执行 `echo "Hello from Browser Bridge"`，返回命令输出」

预期：返回命令执行结果。

### 6.7 组合任务
「在 Browser Bridge 项目中搜索包含 'mcp' 的文件，然后读取其中一个文件的前 20 行」

预期：综合多个工具完成复杂任务。

---

## 7. 失败排查指南

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| 401 Unauthorized | Bearer token 不匹配或缺失 | 从 Bridge 页面重新复制完整 MCP URL 和 Token |
| 403 Forbidden | Origin 不在 allowedOrigins 列表 | 检查 Bridge 配置的 allowedOrigins |
| Unsafe URL | ChatGPT 不接受 http:// URL | 切换到 Cloudflare Quick Tunnel 获取 HTTPS 地址 |
| does not implement OAuth | ChatGPT connector 要求 OAuth | 展开 Advanced，勾选「Allow connecting without a header」 |
| 获取 OAuth 配置时出错 | 同上 | 同上 |
| 连接超时 | 隧道未启动或网络不通 | 确认 Bridge 状态为「运行中」，检查代理设置 |
| health 返回非 200 | 服务端问题 | 查看 DSH Desktop 日志，检查 MCP 服务是否正常 |
| 隧道启动失败（domain 校验） | Cloudflare Named Tunnel 域名填写错误 | 检查配置中的公网主机名是否与 Cloudflare 控制台一致 |
| 隧道启动失败（token 校验） | Tunnel Token 错误或失效 | 重新在 Cloudflare 控制台复制 Tunnel Token |

### 排查时提供的信息

遇到问题时，请提供：

1. Bridge 页面显示的状态（运行中 / 停止 / 启动失败）
2. MCP URL（完整地址，隐藏 Bearer token 部分）
3. 隧道模式（none / cloudflare / cloudflare-named / ngrok）
4. 复现步骤（操作顺序）
5. 完整的错误信息截图或文字

---

## 附录：快速打开站点一览

| 站点 | 网址 | Connector 支持 | Agent 模式支持 | 登录要求 |
|------|------|:---:|:---:|:---:|
| ChatGPT | chatgpt.com | 支持 | 支持 | 订阅 |
| Kimi | kimi.moonshot.cn | — | 支持 | 免费 |
| WorkBuddy | workbuddy.cn/app | 支持 | 支持 | 免费 |
| Manus | manus.im/app | — | 支持 | 免费 |
| Shunova | shunova.cc | — | 支持 | 免费 |

> 「Connector 支持」表示该网站有官方的 MCP/Plugin Connector 配置入口。
> 「Agent 模式支持」表示可以通过在对话开头粘贴 MCP 提示词来连接。
