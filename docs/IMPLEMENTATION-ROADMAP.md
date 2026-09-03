# Implementation Roadmap: Web-Agent Parity

## Status

Advisory companion to ADR-0002 (Proposed). Line numbers and file layout are
accurate as of 2026-09-02. This document describes what to change and where;
it does not contain code.

## 1. Verified source facts that shape implementation

Every Phase 1 change must respect these facts. They were confirmed by reading
the source on 2026-09-02.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | Two workspace adapters. `LocalWorkspaceAdapter` (node fs) is used only when `commandRuntime: 'local'` or in standalone CLI runtime; the dsh-hosted Bridge uses `DshWorkspaceAdapter` (dsh fs seam). Default is `'auto'`. | `src/dsh-plugin.ts:472-478`, `src/runtime.ts:61`, `src/config.ts:107` |
| F2 | The dsh fs seam has **no delete** and **no rename**. Patch delete throws; rename is rejected in both adapters. | `src/workspace/dsh-adapter.ts:322-326`, `dsh-adapter.ts:130`, `src/workspace/patch.ts` |
| F3 | File versions differ per adapter: local = SHA-256; dsh = opaque `FsVersion` surfaced as `String(info.version)`. Callers must echo back whatever `read_file` returned. | `src/workspace/files.ts` vs `dsh-adapter.ts:286-314` |
| F4 | File reads buffer the whole file before slicing; the 512 KiB `maxReadBytes` cap cannot be bypassed with `startLine`/`endLine`. | `src/workspace/files.ts`, `dsh-adapter.ts:296` |
| F5 | `lsp_query` exists only on the dsh adapter; the local adapter has no semantic LSP seam. | `dsh-adapter.ts:500`, `src/types.ts` (`queryLsp?` optional) |
| F6 | Every tool result is text-only JSON; MCP `image` content is never produced. | `result()` in `src/mcp/server.ts` |
| F7 | Tools are registered behind capability flags (`read` / `write` / `command` / `lsp` / `progress`); a disabled capability removes the tool from the list. | `src/mcp/server.ts` (whole file) |
| F8 | `run_command` executes on the user's dsh host, which is Windows (observed cmd/PowerShell). Command snippets must be host-aware. | runtime observation, 2026-09-02 |
| F9 | Write-style ops must stay transactional and version-guarded; the existing patch flow is the reference design (atomic tmp+rename on local, `replaceIfVersion`/`createIfAbsent` on dsh fs). | `src/workspace/patch.ts`, `dsh-adapter.ts:315-385` |

## 2. Canonical change checklist for any new tool

A new workspace tool touches exactly these places, in order. Changing only
`src/workspace/files.ts` has no effect on the dsh-hosted endpoint (F1), which
is the endpoint web connectors actually reach.

1. `src/types.ts` — extend `WorkspaceAdapter` interface and add result types.
2. Core implementation — `src/workspace/files.ts`, or a new module
   (`src/workspace/file-ops.ts`, `src/git.ts`).
3. `src/workspace/adapter.ts` — `LocalWorkspaceAdapter` passthrough.
4. `src/workspace/dsh-adapter.ts` — `DshWorkspaceAdapter` mapping through the
   dsh fs seam.
5. `src/mcp/server.ts` — register the tool under its capability flag with a
   zod schema.
6. `tests/*.test.ts` — unit tests next to the existing suites.
7. `npm run verify` — typecheck + vitest + build, must stay green.

## 3. Phase 0 deliverables (no Bridge code)

| Deliverable | Path | Notes |
| --- | --- | --- |
| Agent self-brief contract | `AGENTS.md` at repository root | Skeleton in ADR-0002 Appendix A. Read `TASK.md` first; search before full reads; read-then-versioned-write; background jobs detached to `.agent/*.log` (Windows: `Start-Process -NoNewWindow -RedirectStandardOutput`); run acceptance commands before done; never handle credentials. |
| Task-state protocol | `TASK.md` per job; optional template at `docs/templates/TASK.template.md` | Goal / Acceptance (exact commands) / State with a `NEXT:` resume line / Notes. Committed with the work so state travels with the branch (enables Phase 3 B1 handoff). |
| Probe task | Update the matrix in `docs/WEB-AGENTS.md` | Metrics in ADR-0002 Appendix C: end-to-end without approval, first stall point and cause, approvals required, wall time, tool calls, observed truncations. |

No build or test step is required for Phase 0.

## 4. Phase 1 per-tool implementation paths

Conventions for every tool below: workspace-relative paths only; symlinks
rejected through the existing containment layer; mutations return versions;
capability-gated registration; one commit per tool with `npm run verify` green.

### 4.1 write_file

- Purpose: create/replace a whole UTF-8 file without synthesizing a diff.
- Schema: `{ path, content, expectedVersion? }`.
- Local path: new `WorkspaceFiles.writeFile` in `src/workspace/files.ts`,
  mirroring the atomic tmp-write + rename pattern from `src/workspace/patch.ts`;
  overwrite only when `expectedVersion` matches current SHA-256 (F9).
- dsh path: reuse the existing dsh fs write seam used by
  `dsh-adapter.ts:315-385` — `createIfAbsent` for new files,
  `replaceIfVersion` for updates. No new fs capability needed.
- Guards: binary (NUL) rejected; content bounded by the 1 MiB request body
  limit; parent directories created.
- Returns: `{ path, version, size, operation: 'create' | 'update' }`.

### 4.2 file_ops (rename / copy / mkdir)

- Purpose: refactors currently require shell `mv`, which bypasses adapter
  containment/versioning semantics.
- Schema: `{ op: 'rename' | 'copy' | 'mkdir', source, target? }`.
- **Preflight gate (F2)**: confirm whether `@deepseek-ai/dsh-fs` exposes a
  rename primitive before committing to the dsh mapping. If it does not, the
  dsh mode of `rename` stays unavailable and `copy`/`mkdir` are implemented
  with existing primitives; document the local-vs-dsh difference (Section 6).
- Local path: node fs through a new `src/workspace/file-ops.ts`.
- delete is intentionally out of scope: the dsh seam has no delete (F2); the
  patch surface already covers deletes in local mode.
- copy: implement via read + versioned write, size-limited until chunked
  reads land (4.3).

### 4.3 Chunked large-file reads (keep the name `read_file`)

- Purpose: files above 512 KiB are currently unreadable even in slices (F4).
- Shape: keep `read_file(path, startLine?, endLine?)`; lift the whole-file
  cap; scan line offsets over a streamed window and return only the requested
  slice; add a `fileSize` field to the result.
- **Preflight gate (F4)**: confirm whether the dsh fs seam offers partial /
  streamed reads. If not, the fallback is configuration, not code: raise the
  `maxReadBytes` default in `src/config.ts` and document the new limit in
  `bridge_info`.
- Keep the existing NUL sniffing on the first window so binary files still
  fail cleanly.

### 4.4 read_many

- Purpose: small-file-heavy work burns request budget (120 rpm) and latency
  on one-file-per-call reads.
- Schema: `{ paths: string[], startLine?, endLine? }` plus a total-bytes cap.
- Implementation: composition over the existing single-file read in both
  adapters; per-file errors instead of whole-batch failure.
- Registered under `capabilities.read`. Pure additive, low risk.

### 4.5 git_status / git_diff

- Purpose: agents constantly ask "what did I just change"; structured output
  is cheaper and more truncation-resistant than raw porcelain parsing.
- Schema:
  - `git_status`: `{}` -> `{ branch, ahead, behind, staged, unstaged, untracked }`
    parsed from `git status --porcelain=v1 -b`.
  - `git_diff`: `{ scope?, staged?, includePatch? }` -> `{ stat: [...], files?: [{ path, patch }] }`,
    patch off by default (numstat only).
- Execution: do **not** add a new exec primitive; run through the adapter's
  existing command seam (local child process / dsh shell, F8 Windows note),
  `execFile`-style with an argument array and no shell interpolation, cwd
  constrained to the workspace root, bounded timeout. Only when `.git` exists.
- Implementation: new `src/git.ts` producing parsed results; registered under
  `capabilities.command`.

### 4.6 LSP additions (stretch)

- `documentSymbol(path)` outline and directory-level diagnostics aggregation.
- Touchpoints: `src/lsp/manager.ts`, dsh adapter only (F5); depends on host
  language-server capabilities. Schedule after 4.1-4.5.

### 4.7 read_image (experimental, default off)

- Purpose: visual verification for UI tasks; requires MCP `image` content,
  which the result helper never produces today (F6).
- Shape: new `capabilities.image` flag (default false); `read_image(path)`
  returns image content when the file is a supported raster within size
  limits; requires a binary read seam on dsh fs.
- Privacy: stays off by default because image payloads travel to the vendor
  product and are retained under its policy (THREAT-MODEL residual risks).
  Enable only after a probe proves the target product renders image content.

### Suggested shipping order

1. 4.1 `write_file` and 4.4 `read_many` first: low-risk additive value.
2. Preflight F2/F4, then 4.2/4.3 in whichever shape the preflight allows
   (implementation or config fallback).
3. 4.5 `git_status`/`git_diff` independently.
4. 4.6/4.7 deferred.

## 5. Verification and rollout path

1. Development: `npm run verify` (typecheck + vitest + build) after each
   commit; keep the whole suite green.
2. Full-semantics smoke test: standalone CLI (`node dist/cli.js start` or
   `npm run dev`) exercises `LocalWorkspaceAdapter`, which covers semantics
   the dsh host cannot (delete, rename, SHA-256 versions). Use the loopback
   URL with a local MCP client.
3. dsh-hosted test: reload the plugin in dsh, copy `mcpUrl` and the bearer
   token from the local `bridge_connection_info` tool, paste them into the
   web product's connector settings, and run the probe task.
4. Update `docs/WEB-AGENTS.md` with autonomy evidence (ADR-0002 Appendix C)
   and keep the README troubleshooting section aligned.

## 6. Local-vs-dsh behavior matrix (document as part of the rollout)

| Behavior | LocalWorkspaceAdapter (`commandRuntime: local`, standalone CLI) | DshWorkspaceAdapter (dsh host, default) |
| --- | --- | --- |
| File delete | supported via patch | unsupported by dsh fs seam |
| File rename | available after 4.2 | depends on F2 preflight |
| File version | SHA-256 | opaque FsVersion |
| Command execution | node child process | dsh shell (Windows host) |
| LSP queries | absent | available |
| Large-file reads | streamed after 4.3 | depends on F4 preflight |

Document this table wherever connectors are described so web agents do not
treat the two modes as identical.

## 7. Decision gates and open questions

- F2/F4 preflight results decide whether 4.2/4.3 are implemented or fall back
  to documentation plus configuration.
- Product ceilings (tool-count caps, autonomy, step caps, image rendering)
  are answered only by Phase 2 probes (ADR-0002).
- Should `apply_patch` gain rename support in the diff language, or is a
  dedicated `file_ops` tool the right shape?
- Should limits (120 rpm, 4 concurrent, 512 KiB reads) become per-profile
  configuration for single-user setups?

## References

- ADR-0002 Web-Agent Parity Program, `docs/ADR-0002-web-agent-parity.md`
- ADR-0001 bridge architecture, `docs/ADR-0001-bridge-architecture.md`
- `docs/WEB-AGENTS.md`, `docs/THREAT-MODEL.md`
- Source touchpoints: `src/types.ts`, `src/mcp/server.ts`,
  `src/workspace/files.ts`, `src/workspace/patch.ts`,
  `src/workspace/adapter.ts`, `src/workspace/dsh-adapter.ts`,
  `src/dsh-plugin.ts`, `src/config.ts`, `src/runtime.ts`, `src/lsp/manager.ts`
