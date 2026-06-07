# Changelog

All notable changes to `@rdk-moss/agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.14] - 2026-06-08

### Fixed

- CLI startup no longer crashes under SOCKS or otherwise unsupported proxy
  environment variables before any model request is made. Moss now avoids
  importing the pi-ai runtime during CLI startup paths that do not need it, and
  the keep-alive dispatcher tolerates unsupported proxy protocols.

## [0.3.13] - 2026-06-08

### Fixed

- CLI sessions: a plain `dmoss` launch now starts a fresh saved session instead
  of reusing the legacy `cli` session and inheriting old conversation history.
  Use `resume --last` or `--session <key>` to continue previous history
  intentionally.

## [0.3.12] - 2026-06-08

### Changed

- CLI identity: Moss now states that it is an AI Agent developed by
  地瓜机器人 (D-Robotics), including the Chinese brand name in the stable
  identity prompt.
- README docs now state the D-Robotics / 地瓜机器人 origin while preserving the
  host-neutral embedding model.

## [0.3.11] - 2026-06-08

### Fixed

- CLI providers: accept API base URLs that already end in `/v1` without
  constructing duplicate `/v1/v1/...` endpoints. This fixes the bundled
  zero-config gateway path used by npm-installed `dmoss`.

## [0.3.10] - 2026-06-08

### Fixed

- update notice: raise the registry check timeout from 800ms to 3000ms. On slower
  networks (e.g. reaching `registry.npmjs.org` from China, measured ~1.9s) the
  800ms check timed out before it could fetch, so the "a new version is available"
  notice never appeared and the cached latest version went stale. The check stays
  async and the timer is unref'd, so the longer wait never blocks startup or exit.

## [0.3.9] - 2026-06-08

### Added

- Zero-config startup: `dmoss` works out of the box with a built-in free model.
  Your own provider/key (env vars or `dmoss setup`) always overrides it. The
  built-in gateway is hidden from `/status`, `/quick_start`, and the welcome panel.
- `/quick_start` now surfaces `AGENTS.md` — the project system-prompt file that is
  auto-loaded every session (scaffold it with `/init`).

### Changed

- The `/quick_start` panel is all-English and explains how to configure the model
  (`dmoss setup` / env vars / config file) and the workspace.

### Fixed

- skills: validate the candidate id up front in `promoteSkillCandidate`
  (path-traversal hardening; the late `removeCandidate` can no longer be the first
  thing to reject the id after a skill is already written).
- cli provider: throw on malformed OpenAI tool-call arguments instead of silently
  using `{}`.
- async tasks: cancelling a parent no longer enters a still-queued child's runner.
- sub-agent orchestration: `runFanOut` / `runPipeline` enforce `timeoutMs` even when
  a child runner ignores the abort signal.
- `compactSession` returns `{ compacted: false }` for histories that fit within the
  keep-recent window, matching its documented contract.
- providers: accept SSE `data:<payload>` frames without the optional space.
- memory: `syncFromFiles` no longer leaves both the old and new entry when a file's
  content changes.
- `web_search` no longer issues a fetch when its signal is already aborted.
- tool registry: re-registering a tool now updates the group snapshot.

## [0.3.7] - 2026-06-04

### Added

- Added a built-in `web_search` tool that completes the web tool pair with
  `web_fetch` (search → fetch). It is keyless by default (DuckDuckGo HTML
  endpoint), supports a Brave provider via `apiKey`/`BRAVE_API_KEY`, and accepts
  a host-injectable custom backend (`search`) for proprietary or multi-engine
  routing. Registered in `builtinTools` and exported as `createWebSearchTool`,
  `duckDuckGoSearch`, and `createBraveSearch`. Existing scaffolding
  (`NETWORK_TOOLS` guard, subagent scope set, output-truncation limit, and the
  "use `web_search` only when registered" prompt guidance) now activates
  natively without an external backplane.
- Added a `move_file` built-in tool for renaming/reorganizing files and
  directories inside the workspace sandbox (both source and destination are
  sandbox-checked; refuses to clobber without `overwrite`).
- Added `offset`/`limit` line-range paging to `read_file` so large files can be
  read in pages instead of stopping at the 100 KB truncation.
- Added background command tools — `exec_background`, `exec_logs`, `exec_stop` —
  backed by an in-process registry so the agent can start and supervise
  long-running processes (dev servers, watchers, `ros2 launch`) that the
  synchronous `exec` cannot. Group-kill on POSIX; an immediate crash during the
  start window is reported inline.
- Added a `code_diagnostics` tool that runs the project's type/lint checks
  (auto-detected for JS/TS via package.json scripts, local tsc, or local eslint;
  or an explicit `command` for ruff/mypy/cargo/go) and reports pass/fail with
  errors and warnings — the "see type errors and warnings after editing" pillar
  of code intelligence. Go-to-definition / find-references stay a language-server
  concern, intended to be wired through the MCP client (an LSP-MCP server).

#### Standalone session richness (parity with host-embedded runs)

- Added an `# Environment` context layer injected at session start by the
  standalone CLI (`context/environment.ts`): working directory, platform, date,
  a shallow top-level file listing, and git state (branch, uncommitted changes,
  recent commits). Snapshotted once per session, so it is prompt-cache friendly.
  This gives standalone `moss` the git/project awareness the RDK Studio host
  previously provided on its own.
- `WorkspaceMemory` now recognizes a project-level `MOSS.md` (and `Moss.md` /
  `moss.md`) as the standalone analog of `CLAUDE.md` / `AGENTS.md`, loaded into
  the workspace-context prompt layer (leading the section) alongside the existing
  `AGENTS.md` / `USER.md` / `MEMORY.md`.
- Added config-driven hooks (`cli/hooks.ts`, `hooks` in the dmoss config) to
  automate workflows: `PreToolUse` (a blocking shell command can veto a tool),
  `PostToolUse` (side-effect automation — format/notify/log), and `SessionStart`.
  Hooks compose with — and run before — the existing tool-approval flow. Each
  command receives a JSON payload on stdin plus `MOSS_HOOK_EVENT` /
  `MOSS_TOOL_NAME` / `MOSS_WORKSPACE` env vars, and is matched to tools by an
  optional `matcher` regex.

### Compatibility

- Backward compatible and additive. New tools are registered in `builtinTools`;
  `read_file` behaves exactly as before when `offset`/`limit` are omitted. The
  `web_search` default backend needs no API key, and its tool name + `query`
  input match the contract host UIs already expect.

## [0.3.6] - 2026-06-01

### Added

- Added an effective host tool inventory projection so hosts can distinguish
  declared tools from tools that are hidden, disabled, denied, or not ready for
  the current session.
- Registered `web_fetch` as a built-in read-only CLI evidence tool with metadata
  and root export coverage.

### Changed

- Refined the interactive TUI output path so transcript text remains visible and
  local shell approval copy stays clear about host-only execution.
- Updated built-in prompt and recovery guidance to reference only Web tools that
  are actually available instead of implying `web_search` is always registered.

### Compatibility

- Backward compatible for existing hosts and CLI consumers. New tool metadata and
  inventory fields are additive.

## [0.3.5] - 2026-05-31

### Added

- Added async task registry support for long-running subagent and host task
  workflows.

### Changed

- Updated the agent package to consume `@rdk-moss/core@^0.3.2`.

### Compatibility

- Backward compatible for existing tool and session consumers.

## [Unreleased]

### Changed

- Each `DmossAgent` now owns a private `PlatformExtensionRegistry`, removing
  the previous last-agent-wins extension knowledge binding. Deprecated extension
  free functions still target the legacy process singleton and bridge startup
  extension knowledge into future agents.
- `DmossAgent.streamChat()` now always delegates to the unified `runAgentLoop` path.
  The legacy inline loop, `DMOSS_AGENT_LOOP_LEGACY` rollback switch, and
  `ChatOptions.experimentalUseAgentLoop` test override were removed so there is
  a single authoritative agent loop.

### Deprecated

The following global free functions are now deprecated (since 0.4.0, removal target 1.0).
Migrate to instance methods on `DmossAgent` or `KnowledgeRegistry` / `PlatformExtensionRegistry`:

| Deprecated function | Replacement |
|---|---|
| `registerKnowledgeModule(mod)` | `agent.registerKnowledge(mod)` |
| `unregisterKnowledgeModule(id)` | `agent.knowledge.unregister(id)` |
| `getKnowledgeModule(id)` | `agent.knowledge.get(id)` |
| `getAllKnowledgeModules()` | `agent.knowledge.getAll()` |
| `findModuleForPlatform(platform)` | `agent.knowledge.findForPlatform(platform)` |
| `getAllDeviceProfiles()` | `agent.knowledge.getAllDeviceProfiles()` |
| `getAllDocEntries()` | `agent.knowledge.getAllDocEntries()` |
| `getAllPromptFragments()` | `agent.knowledge.getAllPromptFragments()` |
| `getAllCommandPatterns()` | `agent.knowledge.getAllCommandPatterns()` |
| `getAllFailureHints()` | `agent.knowledge.getAllFailureHints()` |
| `getAggregatedEcosystemPrompt()` | `agent.knowledge.getAggregatedEcosystemPrompt()` |
| `setVendorPluginCallbacks(cb)` | `agent.extensions.setVendorPluginCallbacks(cb)` |
| `setKnowledgeRegistryForExtensions(reg)` | `agent.extensions.setKnowledgeRegistry(reg)` |
| `applyPlatformExtension(ext)` | `agent.extensions.apply(ext)` |
| `applyPlatformExtensionForce(ext)` | `agent.extensions.applyForce(ext)` |
| `syncPlatformExtensionsAtStartup(factories)` | `agent.extensions.syncAtStartup(factories)` |
| `getRegisteredPlatformExtensions()` | `agent.extensions.getExtensions()` |

Deprecated functions emit a one-time `log.warn` on first call. The warning includes a stack trace
to help identify call sites that need migration.

## [0.3.1] - 2026-05-02

### Added

- **`ToolResult.aborted` / tool end `aborted` metadata** — optional `{ by: 'user' | 'timeout' }`
  marker for host UIs to distinguish user-cancelled single-tool runs from normal tool errors.
  Source: `2026-05-01-moss-device-exec-progress`.

### Compatibility

- Backward compatible for consumers: the field is optional and existing callers may ignore it.

## [0.3.0] - 2026-05-02

### Added

- **`MemoryScope`** — fourth tier `'learning'` (personal learning corpus; stored like other scopes,
  excluded from default system-prompt memory injection on the host — see harness task).
- **`MemoryEntry.topic` / `MemoryEntry.starred`** — optional fields for learning-topic slug and starred flag;
  omit/undefined behaves as no topic / not starred on read paths.
- **`LEARNING_TOPIC_SLUGS`** — exported fixed slug list aligned with the host memory UI whitelist.
  Source: **`2026-05-01-memory-learning-scope-add`**.

### Compatibility

- **Backward compatible for consumers**: new scope value and optional fields only; JSON index remains a
  superset; older clients may ignore unknown fields; existing `workspace`/`user`/`device` semantics unchanged.

### Tests

- `packages/dmoss-agent/test/memory-learning.spec.mjs` — legacy-entry normalization + learning CRUD
  smoke (requires `npm run build` in this package).

## [0.2.2] - 2026-05-02

### Added

- **`ProviderErrorSurface.retryable: boolean`** — required field; only `true`
  for `aborted_by_server` / `rate_limit` / `timeout` / `network` (transient
  categories); `auth` / `quota_exceeded` / `context_corruption` / `unknown` /
  `aborted_by_user` remain `false`. Old callers that ignore the field are
  unaffected at runtime; callers that **construct** surfaces directly need to
  add the field (likely `false` if uncertain).
  Source: `2026-05-01-moss-reliability-fallback-ux` (G-2).
- **`ProviderErrorAction.id: 'useFallbackProvider'`** — new variant in the union
  type; emitted by callers when a user-configured fallback provider is available
  for `auth` / `quota_exceeded` errors. Action is informational only — switching
  always requires explicit user click.
  Source: `2026-05-01-moss-reliability-fallback-ux` (G-3).
- **`ProviderErrorCategory: 'ambiguous'`** — new category for server-side
  `ambiguous_short_circuit` short-circuit decisions, allowing the host to route
  through the same surface + actions pipeline as provider errors.
  Source: `2026-05-01-moss-reliability-fallback-ux` (G-5a).
- **`runWithProviderRetry(fn, opts)`** — new exported helper from
  `@rdk-moss/agent/provider`. Runs `fn`; if first call throws and the classified
  surface is `retryable === true`, sleeps a jittered 800–2000 ms and retries
  exactly **once**. Caller passes a `classify` function (typically
  `classifyProviderError`) and an optional `signal` to abort during the wait.
  - Hard cap: maximum 1 retry (`maxAttempts?: 1`); the type system forbids
    raising it.
  - Eligibility: `aborted_by_server`, `rate_limit`, `timeout`, `network` only.
  - `auth`, `quota_exceeded`, `context_corruption` never auto-retry.
  - Abort-during-wait surfaces the **original** error (not the abort reason),
    so the caller's downstream UX remains accurate.
  Source: `2026-05-01-moss-reliability-fallback-ux` (G-2).
- **Re-exported from `@rdk-moss/agent/provider` root**: `classifyProviderError`,
  `renderProviderErrorSurface`, `sanitizeRawErrorForDetail`, plus types
  `ProviderErrorCategory`, `ProviderErrorAction`, `ProviderErrorSurface`,
  `ProviderErrorInput`. These were previously available only via deep import
  (`./provider/error-classify.js`); the public surface now matches the API.md
  contract for host consumption.
  Source: `2026-05-01-moss-reliability-fallback-ux` (Commit 2 follow-up).

### Compatibility

- All additions are **non-breaking** (additive types, new exports, new helper).
- `renderProviderErrorSurface` behavior is unchanged for backwards compatibility
  with the CLI and Microsoft Teams / 微信 / 飞书 channels. The product host
  consumes the structured surface object directly via SSE error payload + a
  forthcoming `ProviderErrorBlock` for clickable buttons; the markdown text
  rendering remains the fallback for non-rich channels.
- No exports were removed; no signatures changed.

### Tests

- `packages/dmoss-agent/test/error-classify.spec.mjs` — 7/7 (added retryable
  field semantics on 6 categories).
- `packages/dmoss-agent/test/runtime-retry.spec.mjs` — new, 6/6 covering
  retry success, non-retryable abort, retry-then-fail throws last error,
  `shouldRetry` override, pre-aborted signal, and abort-during-wait.

## [0.1.0] - 2026-04-14

### Added

- **DmossAgent** — central orchestrator with `chat()` (Promise) and `streamChat()` (AsyncGenerator) APIs
- **ToolRegistry** — pluggable tool registration and discovery with groups
- **KnowledgeModule** — pluggable domain knowledge system (device profiles, prompts, failure hints)
- **PlatformExtension** — hardware platform lifecycle management
- **ToolHookRegistry** — pre/post tool execution interceptors (Pre/Post/PostFailure)
- **CompactHookRegistry** — compaction lifecycle hooks
- **ToolPipeline** — JSON Schema input validation + pre-hook chain
- **MemoryManager** — long-term memory with BM25 keyword search
- **MiniAgentEvent** — discriminated union event type system with EventStream
- **Context management** — three-layer pruning, adaptive compaction, token estimation
- **Safety** — dangerous command detection, secret sanitization, configurable protected paths
- **Provider** — error classification (rate limit, timeout, overflow), exponential backoff retry
- **Built-in tools** — `read_file`, `write_file`, `list_directory`, `exec`, `search_files`
- **CLI** — interactive, one-shot, and piped modes
- **Configurable APIs** — `registerProtectedPaths()`, `registerToolOutputLimits()`
- **SessionManager** — JSONL persistence + `InMemorySessionStore`
- **Skills** — SKILL.md scanning and matching via `SkillRegistry`
- **Prompts** — vendor-neutral robotics engineering prompts, telemetry hashing

### Architecture

- Core interfaces and contracts are vendor-neutral (from `@rdk-moss/core`)
- Some utility defaults reference host tool names (e.g. `device_exec`) — configurable via `registerToolOutputLimits()` and `registerProtectedPaths()`
- Formal `@rdk-moss/core` dependency (not relative paths)
- All environment variables use `DMOSS_*` prefix
- MIT licensed, ready for independent publication
