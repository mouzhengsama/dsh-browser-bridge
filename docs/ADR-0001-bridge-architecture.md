# ADR-0001: Self-Hosted dsh Bridge Architecture

## Status

Accepted.

## Decision

Implement the Bridge as an MIT dsh bundle plugin that mounts a protected
Streamable HTTP MCP endpoint on `ctx.webServer`, and use replaceable tunnel
providers for optional Internet access.

## Why `ctx.webServer`

dsh already owns the local web server lifecycle and port. Registering a
`prefix` route avoids a second listener, keeps the Bridge inside the dsh
lifecycle, and lets Cordis clean up the route when the plugin is unloaded.
The standalone runtime remains available for CLI use and tests.

## Why Streamable HTTP MCP

The target web AI products and connector ecosystems increasingly consume MCP
over HTTP. The standard transport supports initialization, session ids, and
the normal MCP tool protocol without requiring a custom browser extension or
provider API proxy.

## Why Split Control And Public Tools

The local dsh tool registry receives lifecycle controls such as start, stop,
status, path rotation, and connection information. The public MCP server
receives only workspace tools enabled by capability config. This prevents a
remote caller from changing its own tunnel or rotating its own credentials.

## Why A Native Desktop Browser Surface

The client half replaces the normal conversation view with an operational
browser surface. In dsh Desktop, the host creates Electron `WebContentsView`
instances and mounts them into the dsh main window's `contentView`. This keeps
the web AI login/session inside a real browser context and avoids iframe
limitations and cross-origin embedding failures.

All panes use the named `persist:dsh-browser-bridge` partition. The host does
not cap panes beyond machine and UI resources, supports any number of tabs or
a two-pane split, and routes web popups back into the active pane. The browser
control route is local-only and accepts bounds from the client only after
loopback and cross-site checks.

The client remains loadable in browser-only dsh deployments. If Electron is
unavailable or the dsh desktop window is not ready, the UI reports that state
and shortcut actions fall back to the system browser. This is a capability
degradation, not a second Bridge implementation.

## Why No Central Gateway

The product goal is self-hosting with no time-based Bridge charge. A central
relay would add account state, operating cost, a new trust boundary, and
potential vendor lock-in. Cloudflare and ngrok are optional transport
providers, not a required application service.

## Security Trade-offs

The endpoint is deliberately powerful when write or command capability is
enabled. The design therefore uses capability defaults, random paths,
optional bearer authentication, origin checks, rate limits, request limits,
version checks, path containment, symlink rejection, and readiness checks.
These controls reduce accidental exposure but do not make an untrusted public
agent safe.

## Alternatives Considered

- A second local HTTP server: initially rejected for dsh mode because it
  duplicates lifecycle and port ownership. A minimal loopback connector is now
  used because embedded web pages do not receive the desktop renderer header
  required by the host's carrier access gate.
- A central MCP gateway: rejected because it conflicts with self-hosting and
  adds a paid service dependency.
- A browser extension protocol: rejected because it narrows compatibility to
  specific browsers and AI products.
- An iframe-based embedded browser: rejected because login pages and
  cross-origin policies are not reliable inside iframes, and it does not
  provide a native persistent browser session.
- Copying GPL/AGPL Bridge code: rejected because it is incompatible with the
  intended MIT distribution boundary.
