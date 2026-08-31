# Real dsh Desktop And Public Tunnel E2E

This runbook covers the manual test that cannot be completed by the Node test
suite: a real dsh Desktop process, a real Electron browser view, a real
logged-in web AI session, and a real public tunnel.

## Verified Baseline

A local-only run on dsh Desktop 2.0.4 / Electron 43.3.0 verified the complete
in-process path:

- The profile loaded the workspace plugin through a checkout symlink.
- Persistent local-only startup registered the dsh carrier route and the
  additional loopback connector.
- The Bridge dashboard polled the local control route and reported an
  available embedded browser.
- A local MCP client completed initialization, listed all capability-scoped
  tools, and performed a read-only workspace read through the running dsh
  carrier.

This baseline does not replace the external login and tunnel checks below; it
is the minimum state required before spending time on either.

## 1. Build And Install

Run these commands from the plugin checkout:

```powershell
npm install
npm run typecheck
npm test
npm run build
dsh plugin --profile browser-bridge add .
```

Start the desktop profile:

```powershell
dsh --profile browser-bridge
```

The profile must load both the host entry
`@dsh/browser-bridge` and the generated `./client` bundle.

## 2. Local-Only Smoke Test

Start with a local-only profile so tunnel failures cannot hide browser
integration problems:

```yaml
- insert:
    - id: dsh-browser-bridge
      name: '@dsh/browser-bridge'
      config:
        requireBearerToken: true
        capabilities:
          read: true
          write: false
          command: false
          lsp: true
          progress: true
        tunnel:
          provider: none
        persistentMode: false
```

In the dsh conversation:

1. Open the `Bridge` conversation view.
2. Confirm the Bridge dashboard reports that the embedded browser is
   available.
3. Click the ChatGPT shortcut.
4. Sign in inside the embedded page.
5. Open a second shortcut, then open another one with the plus button.
6. Switch between single and split layouts and close both panes.
7. Return to the dashboard and start the Bridge.
8. Confirm that a running Bridge reports a local MCP URL and health URL.

For a local MCP client, use the reported MCP URL and Bearer token. For this
stage, a successful `listTools` call and a read-only `read_file` call are
enough.

Close and reopen dsh, then open ChatGPT again. The login should still be
present because the native views use the
`persist:dsh-browser-bridge` partition.

## 3. Cloudflare Quick Tunnel

Install and verify the tunnel CLI:

```powershell
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
cloudflared --version
```

Open **Connection Settings** in the Bridge dashboard, choose **Cloudflare
Quick Tunnel**, and start the Bridge. No account, domain, or tunnel token is
needed. Wait until the dashboard reports a public origin. Use the copy action
only after that state appears.

From a second network, check the public health URL:

```powershell
curl.exe -i "https://PUBLIC_HOST/mcp/SECRET_PATH/health" `
  -H "Authorization: Bearer BEARER_TOKEN"
```

Expected result:

```json
{"ok":true,"protocol":"streamable-http","sessions":0}
```

Create a custom MCP connector in the target web AI product with the complete
MCP URL and the Bearer token. If the product has no connector UI, send the
complete copied prompt as the first message of a new agent-capable
conversation. Ask the agent to list the workspace files, then read one small
known file.

Stop and start the Bridge once. Quick Tunnel should produce a new public
origin and a new MCP URL. The old URL must return 404 or an authentication
failure.

## 4. Named Tunnel Or ngrok

For a stable address, test one provider at a time.

### Cloudflare Named Tunnel

Configure a Cloudflare Published application whose service URL points to the
local service URL shown by the Bridge dashboard. In **Connection Settings**,
select **Cloudflare Named Tunnel**, enter `mcp.example.com` and the Tunnel
Token, then save before starting the Bridge. Confirm that the token does not
appear in `.dsh-bridge/config.json`, process arguments, or normal status
output. The public health URL and MCP URL should keep the configured hostname
across a dsh restart.

### ngrok

Install and authenticate ngrok outside the plugin:

```powershell
ngrok config add-authtoken YOUR_AUTHTOKEN
ngrok version
ngrok config check
```

Configure:

```yaml
tunnel:
  provider: ngrok
  ngrokDomain: your-name.ngrok-free.dev
  ngrokUseHttpProxy: false
```

Start the Bridge and repeat the health, connector, read-only tool, and restart
checks. Keep `ngrokUseHttpProxy` disabled unless the account and network
require ngrok to use an HTTP proxy.

## 5. Permission Regression

Repeat the agent test with each capability combination:

| read | write | command | Expected |
| --- | --- | --- | --- |
| on | off | off | list, search, and read work |
| on | on | off | patch works only with matching versions |
| on | off | on | command output can be started and polled |
| off | off | off | public workspace tools are unavailable |

Use a disposable workspace for write and command tests. Rotate the MCP path
after every test in which the URL is copied to an untrusted chat.

## 6. Failure Diagnosis

- Embedded browser unavailable: confirm the test is running in dsh Desktop,
  not a browser-only dsh deployment.
- Login disappears after restart: confirm the page was opened by the native
  view and that the partition name is `persist:dsh-browser-bridge`.
- Public health check times out: check QUIC/UDP 7844 and the system or TUN
  proxy; an ordinary HTTP proxy may not carry Cloudflare Quick Tunnel.
- Connector gets 401: copy the current Bearer token again after a restart or
  path rotation.
- Old MCP URL still responds: stop the Bridge and verify the tunnel process
  has exited before starting the next provider.
- Browser control requests fail: the control route intentionally accepts only
  loopback requests and rejects cross-site browser requests.

The automated suite covers the MCP handshake, dsh carrier route, tunnel
process parsing, browser host lifecycle, control-route validation, client
bundle loading, and plugin cleanup. It does not supply credentials, click
through an external login, or claim a public tunnel is reachable without a
real network.
