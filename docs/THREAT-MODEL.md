# Threat Model

The Bridge grants a remote agent access to the local dsh workspace. Treat the
MCP URL and bearer token as high-value capabilities.

## Assets

- Source files and project history.
- File writes and patch operations.
- Shell commands and their output.
- Language-server information.
- Tunnel credentials and local secret material.

## Main Threats

### URL or token leakage

A leaked random MCP path or bearer token can authorize remote tool calls.
Rotate the path with `bridge_reset_path`, stop the Bridge, and revoke any
associated tunnel credential after a suspected leak.

### Public exposure

The tunnel makes the endpoint reachable from the Internet. Use a bearer token,
restrict origins where practical, keep capabilities minimal, and stop the
Bridge when it is not needed.

### Command execution

Command capability is disabled by default. Enabling it allows the connected
agent to run commands in the dsh workspace. Do not enable it for an untrusted
agent or a shared public URL.

### File writes

Write capability is disabled by default. Patches are workspace-relative,
validate file versions, reject symlinks, reject traversal, and do not expose
file deletion through the dsh adapter.

### Symlink and path traversal

The adapter resolves targets through dsh fs, checks workspace containment, and
does not follow symlinks during traversal or mutation. The MCP protocol
accepts workspace-relative paths only.

### Origin and host abuse

The HTTP layer checks request authorization and configured origins. The public
origin is explicitly allowed after tunnel startup, so an arbitrary Origin is
not automatically trusted.

### Resource exhaustion

Request body size, requests per minute, concurrent requests, file reads,
search results, command output, and command wait time are bounded by config.

## Residual Risk

- A trusted tunnel provider can observe transport metadata and route traffic.
- A compromised dsh process or OS account can bypass application-level
  protections.
- dsh shell and LSP capabilities retain the permissions granted by their
  host services.
- Browser AI products may retain prompts or tool results in their own logs.
- No network endpoint can make a powerful command capability safe for an
  untrusted principal.

## Operational Checklist

- Prefer `provider: none` for local-only use.
- Use a dedicated profile and workspace when enabling writes or commands.
- Keep the MCP URL out of public prompts and screenshots.
- Rotate the path after any accidental disclosure.
- Review the selected web AI product's data retention and connector policy.
