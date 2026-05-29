# Changelog

All notable changes to `@rdk-moss/agent` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  excluded from default system-prompt memory injection on the Studio host — see harness task).
- **`MemoryEntry.topic` / `MemoryEntry.starred`** — optional fields for learning-topic slug and starred flag;
  omit/undefined behaves as no topic / not starred on read paths.
- **`LEARNING_TOPIC_SLUGS`** — exported fixed slug list aligned with Memory Drawer Studio UI whitelist.
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
  with the CLI and microsoft Teams / 微信 / 飞书 channels. The Studio host
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
