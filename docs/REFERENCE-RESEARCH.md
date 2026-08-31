# Reference Research

This project was designed after comparing existing Bridge and MCP gateway
implementations. The references informed protocol and operational choices;
their source code was not copied into this repository.

## References

- `agentic-community/mcp-gateway-registry` (Apache-2.0): gateway and registry
  composition patterns.
- `xyTom/coding-tools-mcp` (Apache-2.0): workspace-oriented MCP tool shape.
- `aiguicai/Chat-Plus`: browser AI Bridge workflow and connector-oriented UX.
- `aiguicai/MCP-Gateway`: MCP gateway and transport composition ideas.
- `cham-woomjack/OpenClaw-WebAI-Bridge`: web-agent to local-tool workflow.
- `chen-squared/browser-ai-bridge`: browser AI Bridge interaction model.
- `PrimeFactorsX/Airgap-Bridge`: guarded local-to-remote tool exposure.
- `Pasumao/dsh-plugin-dev-kb` (MIT): dsh plugin, configuration, lifecycle, and
  bundle conventions.

## Adopted Patterns

- Use standard Streamable HTTP MCP transport rather than a custom polling
  protocol.
- Separate a local control surface from the public MCP tool surface.
- Keep all workspace paths relative at the protocol boundary.
- Use a random capability URL and an optional Bearer token.
- Make the dsh web server the HTTP carrier so the plugin does not claim a
  second application port.
- Treat tunnels as replaceable child-process providers with readiness checks.
- Make capabilities explicit so write and command execution are opt-in.

## What This Implementation Adds

The referenced projects mainly inform the Bridge protocol, gateway shape, and
web-agent connection workflow. This plugin adapts those ideas to dsh's actual
extension contracts:

- The MCP endpoint is a dsh `ctx.webServer` prefix route, so dsh owns the
  listener and lifecycle.
- Bridge lifecycle and connection information are local dsh tools; the public
  MCP surface cannot start, stop, or reconfigure itself.
- The client half is a dsh `conversation.view` registration that replaces the
  normal conversation surface with an embedded browser workspace.
- Electron `WebContentsView` plus
  `persist:dsh-browser-bridge` provides native login/session persistence;
  browser-only deployments use a system-browser fallback.
- The desktop surface exposes a local-only bounds/action control route and lets
  workspaces hold as many panes as system resources allow.
- The distribution boundary is self-hosted MIT code with no time-based Bridge
  charge. Cloudflare and ngrok remain replaceable transport providers rather
  than a required gateway service.

These are integration and ownership decisions, not claims that the referenced
projects implement the same dsh plugin contract.

## License Boundary

Apache-2.0 and MIT references can be used for implementation research subject
to their licenses. GPL or AGPL references, and references without a clear
license, are methodology-only inputs here. No GPL or AGPL source is merged
into this MIT project.
