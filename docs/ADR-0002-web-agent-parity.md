# ADR-0002: Web-Agent Parity Program

## Status

Proposed (2026-09-02). Not yet implemented. Phases are advisory; each phase is
independently shippable, measurable, and reversible.

## Context

The Bridge already lets web AI products (Kimi, ChatGPT, WorkBuddy, and other
custom-MCP connectors) read, search, patch, and run commands in this workspace.
The product goal goes further: **a web AI connected through the Bridge should
complete the same real work that a local harness agent completes** — an agent
loop running inside dsh, connected to a model API, with full local tools.
"Same work" spans all task types: code/test iteration, refactoring and review,
UI verification, and operational/scripting jobs. Where exact parity is
architecturally impossible, the plan targets the closest approximation
available, and states explicitly where the boundary is intentional.

### Parity model: four gap layers

| Layer | What lives here | Controllable | Response |
| --- | --- | --- | --- |
| L1 Tool surface | File-op limits, no image content, no git semantic tools, narrow LSP surface | Yes (code) | Phase 1 tool additions |
| L2 Task & session continuity | Vendor conversations are ephemeral; background jobs tied to requests; concurrent writers | Partly (protocol/patterns) | Phase 0 conventions |
| L3 Vendor product policy | Approval gates, step caps, tool-count caps, context truncation, image rendering, connector drift | No (measure, converge) | Phase 2 probe + channel selection |
| L4 Trust boundary | Credentials, publish, anything requiring secret material | Intentionally closed | Kept closed; sanctioned paths documented |

The single most important observation: **tool count is not the primary gap.**
Long-task completion is dominated by L2 (state does not survive a conversation)
and L3 (product-imposed limits). Phases are ordered accordingly.

### Verified baseline (2026-09-02, from source)

- 14 tools, all registered behind capability flags in `src/mcp/server.ts`.
- Every tool result is text-only (`result()` in `src/mcp/server.ts`); MCP
  `image` content is never produced.
- `read_file` enforces a whole-file size cap (512 KiB, `maxReadBytes`) before
  line slicing in `src/workspace/files.ts`; `startLine`/`endLine` cannot bypass
  it, so files above the cap are unreadable through the tool surface.
- `apply_patch` supports create/update/delete but explicitly rejects renames
  (`src/workspace/patch.ts`, mirrored in `src/workspace/dsh-adapter.ts`).
- `search_text` matches whole lines, caps at `maxSearchResults` (200), and
  skips files above `maxReadBytes`.
- No whole-file write tool exists; generated or scaffolded content must be
  expressed as a diff.
- `run_command` already covers cwd/env/stdin/terminate/incremental output with
  waitMs; limits: 120 req/min, 4 concurrent, 2 MiB command output.
- LSP surface: per-file diagnostics plus goToDefinition / findReferences /
  goToImplementation / hover (`lsp_query`).
- The command tool executes on the user's dsh host, which is Windows
  (observed cmd/PowerShell, 2026-09-02); command snippets must be
  host-aware, and workspace docs must not assume POSIX-only utilities.
- Optimistic file versioning (SHA-256) with transactional, rollback-capable
  patch application is already in place and must be preserved.

## Decision

Adopt a phased parity program on the existing architecture. Do not replace the
Streamable HTTP transport, and do not introduce a central gateway (ADR-0001).
Preserve all invariants: capability-scoped tool listing, workspace-relative
paths, optimistic versioning, symlink/traversal rejection, local-only
lifecycle control, no wildcard origins, and **credentials never exposed to the
public tool surface**.

### Phase 0 — Protocol layer (no Bridge code)

1. A root `AGENTS.md` self-brief contract so every connected agent, regardless
   of product or model, starts a session with the same operating rules
   (Appendix A).
2. A task-state protocol: `TASK.md` per job (goal, acceptance commands,
   completed steps, next step, resume point) so work survives session loss,
   product switches, and step caps (Appendix B).
3. Background-job convention: long-running work is detached and
   polled via log files, never held inside a request-bound
   `commandId`. Use the host-appropriate form: `nohup ... >
   .agent/<job>.log 2>&1 &` on POSIX, or `Start-Process -NoNewWindow
   -RedirectStandardOutput .agent/<job>.log` on the Windows dsh host.
4. Output discipline: search-first, line-range reads, `git diff --numstat`
   style summaries — vendor contexts truncate large tool results.
5. A probe task with recorded metrics, feeding the evidence table in
   `WEB-AGENTS.md` (Appendix C).

**Exit criteria:** one product completes the probe task end-to-end without
human step approval, or the blocking step is recorded precisely in the matrix.

### Phase 1 — Tool surface additions (Bridge code)

Additive, capability-gated, individually shippable. Specifications in
"Phase 1 tool specifications" below.

- 1.1 `write_file` — create/replace whole UTF-8 files with version guard.
- 1.2 `file_ops` — rename/move, copy, mkdir (delete stays on the patch
  surface until the dsh adapter seam is confirmed).
- 1.3 Chunked large-file reads — read >512 KiB files by line range via
  streamed offset scan instead of whole-file buffering.
- 1.4 `read_many` — batch read with per-file caps and per-file errors.
- 1.5 `git_status` / `git_diff` — structured, cheap-to-parse git surfaces.
- 1.6 (stretch) LSP `documentSymbol` and directory-level diagnostics
  aggregation.
- 1.7 (experimental, default off) image content for visual verification.

**Exit criteria:** `npm run verify` green; every tool exercised by the probe
task; dsh adapter mapping covered for tools it must pass through.

### Phase 2 — Measurement and channel convergence

Run the probe task on each candidate product; update `WEB-AGENTS.md` with
autonomy evidence (Appendix C); converge on at most two primary channels and
tune for them. Add per-origin capability profiles only if measurement shows
one product needs a different capability set.

### Phase 3 — Escalation (only if Phases 0–2 leave unacceptable gaps)

- **B1 hybrid commander/executor**: the web agent plans and reviews; the local
  harness agent executes heavy or credentialed steps. Handoff is a git branch
  plus `TASK.md`. Near-zero code; closes L4 and long-task gaps.
- **B2 self-hosted executor**: an orchestration loop the user controls, in the
  v2 direction already sketched in `WEB-AGENTS.md` (multi-model arena; local
  orchestration client via the loopback endpoint or the
  `scripts/dsh-tools-bridge.mjs` stdio adapter). Only justified when L3
  measurably blocks a core workflow after B1.

## Why this order

- Phase 0 costs nothing and addresses the two most common failure modes:
  context starvation and state loss.
- Probe-first (Phase 2) prevents investing in tools that products truncate,
  cap, or render unsupported (image content is the obvious candidate).
- L3 cannot be negotiated away; the only honest strategy is measurement,
  documentation, and channel convergence.
- Security (L4) is a design invariant, not a gap to close; credentialed steps
  are routed to sanctioned paths (human or local harness) instead of being
  exposed.

## Phase 1 tool specifications

Conventions: all paths workspace-relative; symlinks not followed; containment
enforced through the existing `WorkspacePaths` layer; every mutation returns a
version; every tool is registered behind its capability flag in
`src/mcp/server.ts`; tests land next to existing `tests/*.test.ts`.

### 1.1 write_file

- Schema: `{ path: string, content: string, expectedVersion?: string }`.
- Semantics: create when absent; overwrite only when `expectedVersion` matches
  the current SHA-256 (mirrors `apply_patch` optimism); parent directories are
  created; rejects binary content.
- Returns: `{ path, version, size, operation: 'create' | 'update' }`.
- Code touchpoints: `WorkspaceFiles.writeFile` in `src/workspace/files.ts`,
  adapter passthrough, registration under `capabilities.write`.
- Why: generated/scaffolded content no longer needs a synthetic diff; fewer
  tokens, fewer hunk failures.
- Risks: accidental clobber — mitigated by the version requirement (read
  before write becomes mandatory); request body limit — enforce a per-call
  content cap consistent with `requestBodyLimit`.

### 1.2 file_ops

- Schema: `{ op: 'rename' | 'copy' | 'mkdir', source: string, target?: string }`
  (target required except for mkdir).
- Semantics: rename refuses when target exists; copy reads/writes through the
  versioned file layer; mkdir is recursive; delete intentionally stays on the
  `apply_patch` surface until the dsh adapter's delete behavior is confirmed.
- Returns: affected path(s) plus new versions for files.
- Code touchpoints: new `src/workspace/file-ops.ts`, adapters, registration
  under `capabilities.write`.
- Why: patch engine rejects renames; refactors currently require shell `mv`,
  which skips the adapter's containment/versioning semantics.
- Risks: dsh fs adapter rename support is an open question (see below).

### 1.3 Chunked large-file reads

- Keep `read_file(path, startLine, endLine)` but lift the whole-file cap:
  stream the file in small windows, scan line offsets, and return only the
  requested slice (slice cap configurable, default 512 KiB of text).
- Returns: existing `VersionedFile` shape plus `fileSize`.
- Code touchpoints: `WorkspaceFiles.readFile` rework in `src/workspace/files.ts`,
  dsh adapter mapping, limits documentation.
- Why: verified gap — files above `maxReadBytes` are currently unreadable even
  in slices; generated bundles, snapshots, and lockfiles are common in real
  work.
- Risks: dsh fs partial-read seam unknown; binary sniffing must still reject
  NUL bytes in the first window.

### 1.4 read_many

- Schema: `{ paths: string[], startLine?, endLine? }` plus a total-bytes cap.
- Semantics: returns a map of path → `{ version, content }` or per-file error;
  one bad file does not fail the batch.
- Registration under `capabilities.read`.
- Why: small-file-heavy work burns request budget (120 rpm) and latency on
  one-file-per-call reads.

### 1.5 git_status / git_diff

- Schema:
  - `git_status`: `{}` → `{ branch, ahead, behind, staged: [...], unstaged: [...], untracked: [...] }` parsed from `git status --porcelain=v1 -b`.
  - `git_diff`: `{ scope?: glob, staged?: boolean, includePatch?: boolean }` →
    `{ stat: [{ path, added, deleted }], files?: [{ path, patch }] }`; patch
    off by default (numstat).
- Execution: `execFile` with an argument array (no shell interpolation), cwd
  constrained to the workspace root, timeout bounded; only when the workspace
  contains `.git`.
- Registration under `capabilities.command` (it executes git).
- Why: agents constantly answer "what did I just change"; structured output is
  cheaper and truncation-resistant compared with raw porcelain parsing.
- Risks: git availability; huge diffs — mitigated by defaulting to stat-only
  and scoping with globs.

### 1.6 LSP additions (stretch)

- `documentSymbol(path)` → capped outline of symbols (name, kind, range,
  children) for cheap navigation without full reads.
- Diagnostics aggregation for a directory with a cap, replacing per-file
  round trips.
- Requires extending the LSP manager seam and host language-server support;
  schedule only after 1.1–1.5 land.

### 1.7 Image content (experimental, default off)

- `read_image(path, maxBytes?)` returning MCP `image` content when the file is
  a supported raster format and within limits.
- Gated behind a new `capabilities.image` flag (default false) because image
  payloads travel to the vendor product and are retained under its policy
  (THREAT-MODEL residual risks).
- Enable only after a probe proves the target product renders image content.

## Security boundary and sanctioned paths

L4 remains closed by design:

- Secrets (keyring entries, tunnel tokens, stored git credentials) stay off
  the tool surface.
- Credentialed steps — `git push` to remotes requiring stored credentials,
  `npm publish`, internal-network access — are performed by the human or by
  the local harness agent (Phase 3 B1), not by web agents.
- The README troubleshooting section and this ADR state the boundary so
  "same as a local agent" expectations stay calibrated.

## Consequences

Positive:

- Zero-code Phase 0 raises completion rates immediately and is product-agnostic.
- Phase 1 closes every verified L1 gap; tool list stays additive and
  capability-gated.
- Phase 2 produces evidence instead of assumptions about vendor limits.
- B1/B2 escalation paths already have building blocks (`dsh-tools-bridge.mjs`,
  v2 arena direction) so they are cheap to start later.

Negative and trade-offs:

- Tool-count growth may exceed some vendor connectors' implicit limits; keep
  additions minimal and merge where possible (1.3 stays inside `read_file`).
- Each new tool adds adapter surface (local adapter + dsh adapter) and tests;
  maintenance cost scales with the tool list.
- Chunked reads and file ops require dsh adapter seam work whose feasibility
  is unverified (open questions).
- Image content trades privacy for capability and stays off by default.

## Alternatives considered

- Jump straight to a self-hosted executor (B2 now): deferred — product
  connectors may already suffice once L1/L2 are fixed; B2 is the most
  expensive option and its necessity must be measured.
- Add every candidate tool immediately: rejected — measurement first,
  minimalism second.
- Per-origin capability profiles today: deferred to Phase 2, only if the probe
  matrix shows a real need.
- Central gateway or relay: rejected in ADR-0001; unchanged.
- Weakening the security boundary to reach full parity: rejected — L4 is an
  invariant, and Phase 3 B1 covers credentialed work legitimately.

## Open questions

- Does the dsh fs adapter expose rename and partial/streamed reads? Blocks
  1.2 and 1.3 feasibility on the dsh-hosted path.
- What are the target products' real ceilings (tool-count caps, autonomy,
  step caps, image rendering)? Answered only by Phase 2 probes.
- Should default limits (120 rpm, 4 concurrent, 512 KiB reads) become
  per-profile configuration for single-user setups?
- Should `apply_patch` gain explicit support for renames in the diff language,
  or is `file_ops` the right shape?

## References

- ADR-0001 bridge architecture, `docs/ADR-0001-bridge-architecture.md`
- Web AI agent matrix and v2 direction, `docs/WEB-AGENTS.md`
- `docs/THREAT-MODEL.md` (L4 invariants)
- Tool registration, `src/mcp/server.ts`
- File layer, `src/workspace/files.ts`; patch engine, `src/workspace/patch.ts`;
  adapters, `src/workspace/adapter.ts`, `src/workspace/dsh-adapter.ts`
- Local orchestration seam, `scripts/dsh-tools-bridge.mjs`

## Appendices

### A. AGENTS.md contract (skeleton, Phase 0 deliverable)

- State the workspace: this is the dsh-browser-bridge repository; verify
  commands are `npm run verify` (typecheck + test + build).
- Read `TASK.md` first when one exists; resume from its next-step field.
- Prefer search over full reads; read by line range; keep tool results small.
- Mutations: read the file first (obtain version), then patch/write with that
  version.
- Long-running work: detach and redirect output to `.agent/*.log`
  (host-appropriate: `nohup` on POSIX, `Start-Process -NoNewWindow
  -RedirectStandardOutput` on the Windows host), then poll the log.
- Before declaring done: run the acceptance commands named in `TASK.md` and
  record results.
- Never ask for, echo, or store credentials; credentialed steps go to the
  human or local executor.

### B. TASK.md protocol (skeleton, Phase 0 deliverable)

A `TASK.md` in the workspace (or a task directory) carries:

- `## Goal` — one-paragraph objective and out-of-scope list.
- `## Acceptance` — exact commands whose green output proves completion.
- `## State` — append-only log: `- [x] step` lines plus a `NEXT:` line naming
  the exact next action so any later session can resume.
- `## Notes` — decisions, traps, and evidence worth keeping.

Conventions: update `State` after every meaningful step; commit `TASK.md` with
work so the state travels with the branch (enables Phase 3 B1 handoff).

### C. Probe task and metrics (Phase 2 deliverable)

A fixed ~20-minute task representative of real work on this repository (for
example: implement a small feature behind a flag, add tests, run
`npm run verify` until green, then open a focused summary). For each product,
record in `WEB-AGENTS.md`:

- End-to-end completion without approval: yes/no.
- Steps executed before the first stall; reason for the stall
  (approval/step cap/context/truncation/tool error).
- Number of human confirmations required.
- Wall-clock time; number of tool calls; observed truncations.

Update cadence: rerun when the product announces connector or policy changes,
and after each Phase 1 tool shipment.
