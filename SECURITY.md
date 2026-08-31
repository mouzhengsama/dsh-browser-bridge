# Security Policy

## Supported Version

The current `main` branch is supported while the project is active. Before
opening an issue, update to the latest commit and confirm that the problem
still reproduces.

## Reporting A Vulnerability

Do not report exploitable details, credentials, URLs, or reproduction material
in a public issue. Use GitHub's **Report a vulnerability** form on the
repository's Security tab. Include the dsh Desktop and plugin versions, the
tunnel mode, affected capability configuration, and a minimal log or
screenshot with all secrets redacted.

## Safe Defaults

- Keep the tunnel provider set to `none` unless public access is required.
- Keep Bearer authentication enabled.
- Keep `write` and `command` disabled unless the connected agent is trusted.
- Treat the complete MCP URL as a capability.
- Rotate the path with `bridge_reset_path` after accidental disclosure.

See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for the trust boundary and
operational checklist.
