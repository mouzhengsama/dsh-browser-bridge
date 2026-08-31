# Web AI Agent Matrix

The embedded browser and the MCP endpoint are intentionally independent. A
site can be opened for a persistent login even when it does not yet support a
custom MCP connector. The table below separates product compatibility from
the Bridge's own transport capability.

## Connection Modes

| Mode | Requirements | Result |
| --- | --- | --- |
| Official MCP connector | The product can configure a Streamable HTTP URL and headers. | Best path. Use `bridge_connection_info` and keep the Bearer token. |
| Agent plus terminal | The product can run an agent, execute a CLI, and access the endpoint. | Paste the MCP connection prompt as the first message of a new conversation. |
| Embedded login only | No MCP support. | Use the page normally; local workspace tools are unavailable unless another supported channel is configured. |

For a public endpoint, select Cloudflare Quick Tunnel, Cloudflare Named
Tunnel, or ngrok before copying the connection. For a local connector that
runs on the same machine, `provider: none` is enough.

## Built-in Sites

| Site | URL | Browser shortcut | MCP support | Current verification |
| --- | --- | --- | --- | --- |
| Kimi | `https://kimi.moonshot.cn` | Yes | Official connector | Verified against a server-side Streamable HTTP connector. |
| ChatGPT | `https://chatgpt.com` | Yes | Product support changes | Embedded browser verified; use the latest official connector policy. |
| WorkBuddy | `https://workbuddy.cn/app` | Yes | Custom connector / agent | Embedded browser verified; connector mode requires a live product test. |
| Arena | `https://arena.ai/agent` | Yes | Custom connector / agent | Not independently verified. |
| Trae | `https://work.trae.cn` | Yes | Custom connector / agent | Not independently verified. |
| Qwen | `https://qwenwork.cn/app/chat` | Yes | Custom connector / agent | Not independently verified. |
| Manus | `https://manus.im/app` | Yes | Custom connector / agent | Not independently verified. |
| Shunova | `https://shunova.cc` | Yes | Custom connector / agent | Not independently verified. |
| Doubao | `https://doubao.com/chat` | Yes | Product-dependent | Not independently verified. |
| DeepSeek | `https://chat.deepseek.com` | Yes | Product-dependent | Not independently verified. |
| Wenxin Yiyan | `https://yiyan.baidu.com` | Yes | Product-dependent | Not independently verified. |
| Tencent Yuanbao | `https://hunyuan.tencent.com/bot/chat` | Yes | Product-dependent | Not independently verified. |
| ChatGLM | `https://chatglm.cn` | Yes | Product-dependent | Not independently verified. |
| Tiangong AI | `https://tiangong.cn` | Yes | Product-dependent | Not independently verified. |

"Not independently verified" means the project ships the shortcut and exact
browser-origin CORS entry but does not claim that the product currently offers
a custom MCP connector. Keep this table honest when a product test succeeds or
fails.

## Add A Site

For a quick shortcut, use **Quick Open** in the Bridge dashboard. It stores an
HTTP or HTTPS URL as a custom link and does not require a code change.

For a built-in shortcut that should be included in every workspace:

1. Add one entry to `BUILT_IN_LINKS` in `src/links.ts`.
2. Add an origin alias only when the product redirects to a different stable
   origin.
3. Extend `tests/links.test.ts` and, if needed, `tests/client-bundle.test.ts`.
4. Run `npm run verify`.

The configured custom origins and all built-in origins are merged for exact
CORS matching. Do not add wildcard origins.

## Compatibility Rules For v2

The planned multi-model arena should continue to treat each model surface as a
separate client of this workspace MCP endpoint. The v1 boundary stays intact:

- No web page can call Bridge lifecycle controls.
- Model orchestration happens outside the protected tool endpoint.
- The public tool list remains capability-scoped.
- A future local orchestration client can use the loopback endpoint or the
  `dsh-tools-bridge` stdio adapter without changing web connector behavior.
