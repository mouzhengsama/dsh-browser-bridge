# dsh Browser Bridge

[中文用户指南](README.zh-CN.md)

Self-hosted, MIT-licensed Bridge plugin for dsh. It exposes the current dsh
workspace as a protected Streamable HTTP MCP server so a logged-in web AI
agent can read, search, patch, inspect, and operate the local project.

The Bridge has no time-based usage fee and does not proxy an AI provider. The
workspace and command execution stay on the machine running dsh.

## Features

- Streamable HTTP MCP endpoint mounted on dsh `ctx.webServer`.
- Workspace-relative file listing, text search, and UTF-8 file reads.
- Optional multi-file unified patches with optimistic file versions.
- Optional workspace shell commands with incremental output.
- Optional dsh LSP navigation and diagnostic responses.
- Progress reporting for long-running remote work.
- Bearer token authentication, random MCP path, origin checks, rate limits,
  concurrent request limits, and request body limits.
- Cloudflare Quick Tunnel, Cloudflare Named Tunnel, ngrok, or no tunnel.
- Exact CORS preflight for the built-in web AI origins, with optional custom
  origins for other client-side connectors.
- Secret path, bearer token, and named tunnel token stored in the OS keyring.
- A dsh Desktop browser surface backed by Electron `WebContentsView`.
- Persistent web login state in the `persist:dsh-browser-bridge` partition.
- Single-pane and two-pane browser layouts with tabs, navigation controls,
  address bars, built-in web AI shortcuts, and custom shortcuts.
- A system-browser fallback when the plugin is running outside Electron.

## Install As A dsh Bundle

From a checkout:

```sh
dsh plugin --profile demo add ./path/to/browser-bridge
```

The package contains `cordis.patch.yml`, which loads the namespace plugin
entry point `@dsh/browser-bridge`. For a git install, dsh may ask for
permission to run the package `prepare` build script. Only approve source you
trust.

After installation, start dsh with the profile:

```sh
dsh --profile demo
```

The bundle adds the local control tools:

- `bridge_status`
- `bridge_start`
- `bridge_stop`
- `bridge_reset_path`
- `bridge_connection_info`

The public MCP tools are created only inside a running Bridge session.

## Embedded Browser Surface

The client face replaces the default conversation body and composer with a
browser-style workspace. Built-in shortcuts open ChatGPT, Arena, WorkBuddy,
Trae, Qwen, Manus, Shunova, Doubao, DeepSeek, Wenxin Yiyan, Tencent Yuanbao,
Kimi, ChatGLM, and Tiangong AI; custom HTTP or HTTPS shortcuts can be added in
the Bridge view.

In dsh Desktop, pages are native Electron `WebContentsView` instances rather
than iframes. The views use the persistent `persist:dsh-browser-bridge`
partition, so signing in once normally keeps the site session for later dsh
starts. Workspaces can hold as many panes as the machine can support; the UI
can show them as tabs in a single layout or two selected panes side by side in
a split layout.

The web client sends only local layout bounds to the dsh control route. Page
contents, cookies, and login credentials remain inside the embedded browser
process. When dsh is running without an Electron host, opening a shortcut
falls back to the system browser and the page is not embedded.

## Configuration

Add a profile overlay with the same plugin id to configure the bundle. The
configuration is validated by the exported Schemastery `Config` schema:

```yaml
- insert:
    - id: dsh-browser-bridge
      name: '@dsh/browser-bridge'
      config:
        requireBearerToken: true
        capabilities:
          read: true
          write: true
          command: true
          lsp: true
          progress: true
        tunnel:
          provider: cloudflare
          ngrokUseHttpProxy: false
        persistentMode: false
```

Keep command and write capabilities disabled unless the remote agent is
trusted. A profile patch replaces the row configuration, so include every
setting that you want to override.

In dsh Desktop, the Bridge dashboard also has a collapsed **Connection
Settings** section. It is writable only while the Bridge is stopped or after a
failed start:

- **Local-only** is the default. It mounts MCP on dsh's loopback web server and
  an additional loopback connector, without creating a public endpoint. The
  exact origins for all built-in web AI shortcuts are allowed automatically;
  add more origins only for trusted client-side connectors.
- **Cloudflare Quick Tunnel** is the zero-configuration public option. Select
  it, then start the Bridge. It creates a new `trycloudflare.com` URL every
  time.
- **Cloudflare Named Tunnel** accepts the public hostname and Tunnel Token.
  The hostname is kept in `.dsh-bridge/config.json` inside the workspace; the
  Token is kept only in the OS keyring.
- **ngrok** remains available when you already reserve a development domain.

The dashboard saves the effective non-secret Bridge configuration to
`.dsh-bridge/config.json`. On each dsh start it restores that file, while the
current dsh web-server host and port always take precedence.

## Connect A Web AI Agent

See [`docs/WEB-AGENTS.md`](docs/WEB-AGENTS.md) for the per-site connection
matrix, verification status, and v2 compatibility rules.

1. Start the Bridge with the local `bridge_start` tool.
2. Call `bridge_connection_info` after the status becomes `running`.
3. Put the returned `mcpUrl` and bearer token into a web AI product's
   official custom MCP connector configuration. A server-side connector can use
   the local origin; a public connector needs one of the tunnel modes. Kimi's
   connector has been verified against this server-side connector path.
4. If the web AI product has no custom MCP connector, paste the complete MCP
   URL and the returned connection instructions into a new agent-capable
   conversation, if that product supports terminal access and outbound HTTPS.

The URL is a capability. Do not post it in public chats, issue trackers, or
screenshots. Use `bridge_reset_path` after a suspected leak.

The Bridge itself is self-hosted and has no time-based usage charge. Cloudflare
and ngrok are optional tunnel providers with their own account, quota, or
network costs. The web AI subscription and any token charges are independent of
this plugin.

## Tunnel Providers

### Cloudflare Quick Tunnel

Install `cloudflared`, then leave the default provider:

```powershell
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
cloudflared --version
```

Each start creates a new temporary `trycloudflare.com` address.

### Cloudflare Named Tunnel

In the Bridge dashboard, choose **Cloudflare Named Tunnel**, enter the public
hostname and Tunnel Token, and save. The Cloudflare Published application
service must target the displayed local dsh web server origin and port. The
token is stored under the configured `cloudflareNamedTokenKey` in the OS
keyring, never in the workspace configuration.

### ngrok

Set `tunnel.provider` to `ngrok`, configure `ngrokDomain`, and authenticate
the local ngrok installation with its own CLI. The Bridge starts ngrok as a
child process and never places the authtoken in command-line arguments. By
default it removes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their lowercase
variants from the ngrok process environment; set
`tunnel.ngrokUseHttpProxy: true` when ngrok must use the configured HTTP proxy.

### No tunnel

Set `tunnel.provider` to `none` for local MCP clients and integration tests.
This does not make the endpoint public. In dsh Desktop, the MCP endpoint also
listens on a second loopback-only connector. This is required because web
pages in the embedded browser do not carry the desktop renderer header used
by the dsh host, while ordinary local MCP clients can still use either
endpoint. The connector accepts only loopback traffic and keeps the same
random path, bearer token, and origin checks as the dsh carrier route.

## Desktop Control Route

The embedded browser is controlled through the dsh web server at
`/browser-bridge/control`. The route is local-only: it accepts loopback
requests and rejects cross-site browser requests. It exposes snapshots and
browser actions for the current workspace, while Bridge lifecycle controls
remain in the dsh tool registry.

The native host is intentionally desktop-only. A browser-only dsh deployment
can still load the client bundle, display the Bridge controls, and open pages
through the system-browser fallback, but it cannot place native browser views
inside the page.

## Development

For a real dsh Desktop, logged-in web AI, and public tunnel test, follow
[`docs/REAL-E2E.md`](docs/REAL-E2E.md).

```sh
npm install
npm run verify
npm pack --dry-run
```

The dsh plugin entry point uses named exports:

```ts
export const name = 'dsh-browser-bridge'
export const inject = ['tools', 'webServer', 'fs']
export const Config = ...
export function apply(ctx, config) { ... }
```

It intentionally has no default export because the dsh loader consumes the
namespace contract.

## Security

Read `docs/THREAT-MODEL.md` before enabling write or command capabilities.
The Bridge is intended for a trusted operator and a trusted web agent. It is
not an anonymous public file server, a reverse proxy for an AI website, or a
multi-tenant gateway.

## License

MIT. See `LICENSE`.
