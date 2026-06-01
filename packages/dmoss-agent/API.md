# @rdk-moss/agent API Reference

This document defines the **stable public API surface** of `@rdk-moss/agent`.

The source of truth is:

1. `packages/dmoss-agent/package.json` export map
2. Root exports in `src/index.ts`
3. Subpath exports in `src/*/index.ts`

Anything a host application builds on top (HTTP servers, frontends, desktop shells, SSH bridges, fleet dashboards, etc.) is the host's concern and is **not** part of the stable API of this package.

**Agent harness:** The exports below are the **harness** around your LLM (tools, context, safety, sessions, retries) — not a full product.

## Installation

```bash
npm install @rdk-moss/agent @rdk-moss/core
```

## Stable Import Paths

| Import path | Purpose |
|------------|---------|
| `@rdk-moss/agent` | Main entry: `DmossAgent`, knowledge helpers, safety, provider, utils |
| `@rdk-moss/agent/core` | Core runtime types and lower-level APIs |
| `@rdk-moss/agent/context` | Context window, truncation, compaction helpers |
| `@rdk-moss/agent/provider` | Provider adapter and retry/error helpers |
| `@rdk-moss/agent/safety` | Secret masking, command/path safety |
| `@rdk-moss/agent/observability` | Redaction, tracing, and LLM usage helpers |
| `@rdk-moss/agent/knowledge` | Knowledge registry access |
| `@rdk-moss/agent/extensions` | Platform extension lifecycle |
| `@rdk-moss/agent/prompts` | Prompt telemetry helpers |
| `@rdk-moss/agent/skills` | Skill registry |
| `@rdk-moss/agent/utils` | Text smoothing, tracing, env helpers |
| `@rdk-moss/agent/channels` | Message channel bridge for external chat platforms |
| `@rdk-moss/agent/tools/builtin` | Built-in filesystem/shell/search tools |
| `@rdk-moss/agent/mesh` | Multi-agent mesh (HTTP + LAN discovery) |
| `@rdk-moss/agent/mcp` | Model Context Protocol client for external tool servers |

### Internal runtime helpers

Some modules exist for internal runtime wiring but are not stable public entry points:

- `@rdk-moss/agent/core/subagent-orchestrator.js` is an internal implementation detail for fan-out / pipeline orchestration. Host applications should not deep import it.
- Observability helpers are stable from `@rdk-moss/agent/observability` and are also re-exported from the root `@rdk-moss/agent` entry (index.ts:256-278).
- `dmossRunTrace` remains available from `@rdk-moss/agent/utils`, not from the root `@rdk-moss/agent` entry.

## API stability labels

These labels describe **semver intent** for `@rdk-moss/agent` **only** (not any embedding host application).

| Label | Meaning |
|-------|---------|
| **Stable** | Symbols reachable through `package.json` `exports` **and** listed in this file (or package `README.md`) for that major line. Breaking removals/renames require a **major** bump. |
| **Experimental** | May change in a minor release. Today this is reserved for features explicitly called out in `CHANGELOG.md` as experimental; if none are listed, treat all documented exports as **Stable**. |
| **Internal** | Anything not re-exported from the supported entry points (e.g. deep imports into `src/...` paths, or host code under `server/`). **Do not rely on these.** |

**Practical rule:** import only from documented paths in the table above; run `npm test --workspace=@rdk-moss/agent` when adding exports.

## Main Runtime API

### `DmossAgent`

The primary runtime class.

```ts
import { DmossAgent, InMemorySessionStore } from '@rdk-moss/agent'
import type { LLMProvider } from '@rdk-moss/agent'

const agent = new DmossAgent({
  llmProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'your-model',
})
```

### `DmossAgentConfig`

Important fields:

| Field | Type | Purpose |
|------|------|---------|
| `llmProvider` | `LLMProvider` | Host-supplied LLM backend |
| `sessionStore` | `SessionStore` | Conversation persistence |
| `model` | `string` | Default model id |
| `baseSystemPrompt` | `string` | Base prompt supplied by host |
| `domainPrompt` | `(() => string) \| false` | Replace or disable default robotics prompt |
| `includeRegisteredKnowledgePrompts` | `boolean` | Merge registered knowledge prompt fragments |
| `hooks` | `AgentHooks` | Host lifecycle hooks |
| `contextTokens` | `number` | Context window budget |
| `enableContextPruning` | `boolean` | Enable pruning |
| `enableCompaction` | `boolean` | Enable compaction |
| `enableThinkingStream` | `boolean` | Enable inline thinking routing |
| `enableSteering` | `boolean` | Enable rule-based steering |
| `enableFollowUpGuard` | `boolean` | Enable follow-up tool detection |

### `ChatOptions`

Per-request options passed to `chat()` / `streamChat()`:

| Field | Type | Purpose |
|------|------|---------|
| `platform` | `string` | Target platform id |
| `abortSignal` | `AbortSignal` | Cancellation |
| `onStream` | `(event: LLMStreamEvent) => void` | Raw provider stream events |
| `ephemeralTools` | `Tool[]` | One-turn tools |
| `extraContext` | `string` | Additional system context |
| `temperature` | `number` | Per-turn sampling override |
| `runId` | `string` | External tracing id |

### `ChatResult`

Returned by `chat()` and emitted by `streamChat()` on `done`:

| Field | Type | Purpose |
|------|------|---------|
| `response` | `string` | Final visible assistant text |
| `toolCalls` | `ToolCall[]` | Tool calls issued by the model |
| `toolResults` | `ToolResult[]` | Tool execution results returned to the model |
| `usage` | `{ inputTokens; outputTokens }` | Optional token usage |
| `thinking` | `string[]` | Extracted thinking content |
| `compactions` | `number` | Number of compaction passes |
| `stopReason` | `string` | Last provider or agent termination reason |

### Goal Mode

Goal Mode is a host-neutral runtime capability for a session/thread. `DmossAgent` stores the current goal in the configured `SessionStore` as an internal checkpoint message and injects active or paused goal context into the system prompt during `chat()` / `streamChat()`.

The runtime does **not** start automatic background work, change host approval policy, or bind to UI. Hosts own command routing, UI controls, scheduling, and any autonomous execution loop. `@rdk-moss/agent/goal` provides an optional `/goal` command adapter so hosts can route commands without duplicating Goal Mode semantics.

| Method | Purpose |
|--------|---------|
| `setGoal(sessionKey, objective)` | Create or replace the thread goal for a session |
| `getGoal(sessionKey)` | View the current `GoalState`, or `undefined` when no goal is stored |
| `pauseGoal(sessionKey, reason?)` | Mark the goal as paused and preserve the reason for prompt context |
| `resumeGoal(sessionKey)` | Mark a paused goal as active again |
| `completeGoal(sessionKey, reason?)` | Mark the goal as completed |
| `blockGoal(sessionKey, reason?)` | Mark the goal as blocked |
| `clearGoal(sessionKey)` | Remove goal state from the session |

| Command Adapter | Purpose |
|-----------------|---------|
| `isGoalCommand(input)` | Fast predicate for host routers before normal chat |
| `parseGoalCommand(input)` | Parse `/goal` input into a structured command |
| `executeGoalCommand(agent, sessionKey, parsedCommand, options?)` | Apply a parsed command through the existing agent goal methods |
| `handleGoalCommand({ agent, sessionKey, input, locale? })` | Parse and execute in one call |
| `formatGoalCommandResult(result, locale?)` | Format a structured result for display |

| Type | Purpose |
|------|---------|
| `GoalState` | Session goal with objective, status, timestamps, and optional status reason |
| `GoalStatus` | Goal lifecycle status: `active`, `paused`, `completed`, or `blocked` |
| `GoalCommandResult` | Machine-readable command result with `handled`, `action`, `event`, `goal`, `message`, and `error` fields |

Supported commands are `/goal`, `/goal status`, `/goal set <objective>`, `/goal pause [reason]`, `/goal resume`, `/goal complete [reason]`, `/goal block [reason]`, and `/goal clear`.

Command results use stable event names for observability: `goal_status`, `goal_set`, `goal_paused`, `goal_resumed`, `goal_completed`, `goal_blocked`, and `goal_cleared`.

`sessionKey` is the goal ownership boundary. A goal belongs only to the exact `sessionKey` passed to the agent or command adapter. Subagents, mesh peer queries, external channel sessions, and other host-specific conversations do not inherit a parent goal unless the host explicitly passes or copies that goal into their own session. Mesh peer queries should use their own session keys when they must not mutate a host main session goal.

Completed and blocked goals are stored for hosts to inspect until cleared, but only active or paused goals are injected as model guidance.

## Event Model

There are **three different event layers** in the package. This distinction matters for host integrations.

### 1. `DmossAgentEvent`

Returned by `agent.streamChat()`:

```ts
type DmossAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; toolCallId: string; result: string; isError: boolean; aborted?: { by: 'user' | 'timeout' }; structuredContent?: ToolContentBlock[] }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string; totalToolCalls?: number }
  | { type: 'error'; error: string; retriable: boolean }
  | { type: 'compaction'; summaryChars: number; droppedMessages: number; checkpointOutline?: string[] }
  | { type: 'working_context_checkpoint'; status: string; reason: string; goal: string; nextAction: string }
  | { type: 'microcompact'; compressedCount: number; savedChars: number; savedTokens: number }
  | { type: 'done'; result: ChatResult }
```

Use this for product UIs, CLIs, or streaming consumers.

### 2. `LLMStreamEvent`

Delivered to:

- `ChatOptions.onStream`
- `AgentHooks.onStream`

These are **provider-native** streaming events such as `message_delta`, `content_block_delta`, and `message_stop`. Use them when you need raw model-level streaming rather than agent-level semantic events.

### 3. `MiniAgentEvent`

Available from `@rdk-moss/agent/core`. This is a lower-level internal runtime event union used by the agent loop and advanced hosts.

Typical examples:

- `message_delta`
- `thinking_delta`
- `tool_execution_start`
- `tool_execution_end`
- `compaction`
- `context_action`
- `retry`
- `run_metrics`

Use `MiniAgentEvent` only if you intentionally want the lower-level runtime signal set.

## Hooks API

### `AgentHooks`

Host lifecycle extension points:

| Hook | Purpose |
|------|---------|
| `onBeforeToolExec()` | Approve or block a tool call |
| `onToolResult()` | Audit/log a completed tool result |
| `onLLMRequestStart()` | Observe outgoing LLM requests |
| `onLLMResponseEnd()` | Observe completed LLM responses |
| `onStream()` | Receive raw `LLMStreamEvent` |
| `onCompaction()` | Observe compaction activity |
| `onError()` | Decide whether to retry on error |
| `onTurnComplete()` | Observe completed turns |
| `enrichToolContext()` | Inject host-specific fields into `ToolContext` |

Example:

```ts
import type { AgentHooks } from '@rdk-moss/agent'

const hooks: AgentHooks = {
  onBeforeToolExec: async (request) => {
    return { approved: true }
  },
  onToolResult: (call, result) => {
    audit(call.name, result.content)
  },
  enrichToolContext: (ctx, sessionKey) => ({
    ...ctx,
    sessionId: sessionKey,
    deviceId: getActiveDeviceId(sessionKey),
  }),
}
```

## Tool System

### `Tool`

```ts
interface Tool<TInput = any> {
  name: string
  description: string
  metadata?: ToolMetadata
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  normalizeInput?: (input: TInput, ctx?: Pick<ToolContext, 'sessionKey' | 'sessionId'>) => TInput
  execute: (input: TInput, ctx: ToolContext) => Promise<string>
  executeStructured?: (input: TInput, ctx: ToolContext) => Promise<StructuredToolResult>
}
```

### `ToolContext`

Base fields available to every tool:

| Field | Purpose |
|------|---------|
| `workspaceDir` | Main workspace directory |
| `bootstrapDir` | Optional host bootstrap directory |
| `extraAllowedRoots` | Additional allowed file roots |
| `sessionKey` | Persistent session key |
| `sessionId` | Optional UI-facing session id |
| `agentId` | Optional agent id |
| `abortSignal` | Cancellation signal |
| `toolCallId` | Current tool call id |

Hosts may add extra fields through `enrichToolContext()`.

### `ToolRegistry`

Use `ToolRegistry` or `agent.tools` to register individual tools or groups:

```ts
agent.tools.register({
  name: 'device_exec',
  description: 'Run a command on a device',
  inputSchema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  execute: async ({ command }) => runDeviceCommand(command),
})
```

## LLM Provider API

### Minimal integration (recommended for new hosts)

The **only** coupling between `DmossAgent` and any vendor SDK is **`LLMProvider`**. For the **smallest behavioral dependency** (and often **no extra LLM SDK** beyond `fetch()`), implement `LLMProvider` yourself and pass it to `DmossAgent`. See the interface definition in the `LLMProvider` section below.

### `LLMProvider`

```ts
interface LLMProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities?: { streaming?: boolean }
  complete(options: LLMRequestOptions): Promise<LLMResponse>
  stream(options: LLMRequestOptions, onEvent: (event: LLMStreamEvent) => void): Promise<LLMResponse>
  countTokens?(text: string): Promise<number>
}
```

`LLMResponse` may include `incomplete?: { reason: string }` when a provider has usable partial content but no trustworthy terminal response. `DmossAgent` treats that as a failed turn and will not call `AgentHooks.onLLMResponseEnd()` for it.

### Optional built-in adapter (`pi-ai`)

`PiAiLLMProvider` is an **optional** bridge for hosts that already integrate **`@mariozechner/pi-ai`**. You do **not** need to import or construct it unless you choose that stack.

The `@rdk-moss/agent` package **depends on** `@mariozechner/pi-ai` at install time so this adapter is always resolvable from npm; your application can still use **only** a custom `LLMProvider` and never reference `PiAiLLMProvider`.

```ts
import { PiAiLLMProvider } from '@rdk-moss/agent'
```

## Session API

Built-in stores:

- `InMemorySessionStore`
- `JsonlSessionStore`

Goal Mode uses the existing `SessionStore` message stream. No new `SessionStore` methods are required; the runtime writes and strips its internal goal checkpoint messages before sending chat history to the model.

Session helpers available from `@rdk-moss/agent/core`:

- `resolveSessionKey()`
- `normalizeAgentId()`
- `buildAgentMainSessionKey()`
- `isSubagentSessionKey()`

## Knowledge and Extension API

Knowledge registry functions exported from the root package:

- `registerKnowledgeModule()`
- `unregisterKnowledgeModule()`
- `getKnowledgeModule()`
- `getAllKnowledgeModules()`
- `findModuleForPlatform()`
- `getAllDeviceProfiles()`
- `getAllPromptFragments()`
- `getAllFailureHints()`
- `getAggregatedEcosystemPrompt()`

Platform extension functions:

- `syncPlatformExtensionsAtStartup()`
- `setVendorPluginCallbacks()`
- `applyPlatformExtension()`
- `getRegisteredPlatformExtensions()`

## Host registration APIs (harness tuning)

Call these **once at startup** in your host application so product-specific tool names and limits are wired into the harness without forking `@rdk-moss/agent`:

| Function | Module | Purpose |
|----------|--------|---------|
| `registerProtectedPaths()` | `@rdk-moss/agent` / `@rdk-moss/agent/safety` | Extra paths that must not be read/written by tools |
| `registerToolOutputLimits()` | `@rdk-moss/agent/context` | Per-tool output truncation caps |
| `setOpenUrlMarkers()` | `@rdk-moss/agent/core` | Success/failure substrings in open-URL tool results (for `web_fetch` suppression) |
| `registerNonMainChannelPrefixes()` | `@rdk-moss/agent/context` | Channel prefixes for non-main sessions |
| `registerSpawnToolExtensions()` | `@rdk-moss/agent/core` | Extra tool names allowed for sub-agent spawns |
| `setVendorPluginCallbacks()` | `@rdk-moss/agent` | Deprecated process-scoped vendor plugin lifecycle hooks |

For new integrations, prefer `agent.extensions.setVendorPluginCallbacks(...)` on the specific `DmossAgent` instance. The free function remains for legacy startup bridges and writes to the deprecated process-scoped extension singleton.

Idempotent replay mutability is declared on each `Tool` through `metadata.sideEffectClass`; there is no exported global mutating-tool hint registry.

## Safety API

Exported from `@rdk-moss/agent/safety` (a subset is also re-exported from the root package):

- `sanitizeSecrets()`
- `containsSecrets()`
- `isCommandDangerous()`
- `isPathProtected()`
- `registerProtectedPaths()`
- `matchTextApproval()`
- `classifyFileKind()`
- `stripShellPrefixBeforeHeredoc()`
- `resolveSandboxPath()` — **only from `@rdk-moss/agent/safety`**
- `assertSandboxPath()` — **only from `@rdk-moss/agent/safety`**

## Agent Mesh

Exported from `@rdk-moss/agent/mesh`:

- `AgentMesh` — multi-agent peer discovery and communication
- `createMeshTools()` — create mesh-backed tools for agent collaboration
- `isMeshVerboseEnabled()` — check verbose logging flag
- `LanDiscovery` — LAN peer discovery via UDP broadcast
- `MeshEventBus` — structured event sink for child runs, approvals, cancellations, and mesh peer lifecycle
- Types: `MeshConfig`, `MeshPeer`, `MeshMessage`, `MeshEvent`, `MeshEventSink`

## Observability API

Exported from `@rdk-moss/agent/observability`:

- `redactSensitiveData()` and `parseTelemetryAllow()` — redact prompts, credentials, IPs, and file-like payloads before telemetry leaves the runtime
- `setTracer()`, `getTracer()`, `withSpan()` — install and use a host-owned tracing bridge
- `turnAttributes()`, `toolAttributes()`, `llmRequestAttributes()` — build stable span attributes
- `logLLMUsage()`, `readUsageLog()`, `summarizeUsage()`, `formatUsageSummary()` — write and inspect JSONL usage records
- `estimateLLMCost()` and `registerModelPricing()` — optional local cost estimation

## Context API

Exported from `@rdk-moss/agent/context`:

- `resolveContextWindowInfo()`
- `evaluateContextWindowGuard()`
- `getEffectiveContextWindowTokens()`
- `truncateToolOutput()`
- `registerToolOutputLimits()`
- `compactSubagentSummaryForParent()`

## Built-in Tools

Exported from `@rdk-moss/agent/tools/builtin`:

- `readFileTool`
- `writeFileTool`
- `listDirectoryTool`
- `execTool`
- `searchFilesTool`
- `searchCodeTool`
- `builtinTools`
- `registerBuiltinTools()`

These are useful for minimal standalone hosts and CLI prototypes.

### Web Fetch Tool

Exported from `@rdk-moss/agent` (root):

- `createWebFetchTool(opts?: WebFetchOptions): Tool`

HTTP(S) fetch tool with SSRF protection, size limits, and HTML-to-text cleanup.

## Channels

Exported from `@rdk-moss/agent` and `@rdk-moss/agent/channels`:

- `bridgeAgentToChannel(agent, channel, options?)`
- Types: `BridgeAgentToChannelOptions`, `ChannelMessage`, `ChannelResponse`, `MessageChannel`

`bridgeAgentToChannel` serializes messages per sender and applies a per-message `chatTimeoutMs` (default: 120 seconds) so one stalled upstream request cannot permanently block that sender's queue.

## Provider stream errors (implementation note)

`PiAiLLMProvider`（`@rdk-moss/agent/provider`）在 pi-ai 流式 `type=error` 且缺少可见 `content`、仅带 `errorMessage` 时，会把它作为 provider/runtime 错误抛出，不能写入 assistant `text` block。宿主应在错误路径用 `src/provider/error-classify.ts`（`classifyProviderError`、`renderProviderErrorSurface`、`sanitizeRawErrorForDetail`）生成结构化错误 UI 或渠道 fallback，避免把“模型暂时不可用”归档成正常回答。

示例（宿主侧应通过正常 `streamChat` 消费结果，而非直接调用下列 API）：

```ts
// 说明性伪代码 — 实际由 PiAiLLMProvider 内部调用
import { classifyProviderError, renderProviderErrorSurface } from './provider/error-classify.js';

const surface = classifyProviderError({
  errorMessage: rawFromSdk,
  status: 401,
});
if (!surface.silent) {
  const markdown = renderProviderErrorSurface(surface);
  // → 仅用于错误 UI / CLI fallback；不要进入 assistant content text block
}
```

用户主动取消（`abortReason: 'user'`）时 `surface.silent === true`，不应再写入 assistant 消息。写入数据库 `error_detail` 前请对 raw 串调用 `sanitizeRawErrorForDetail`。

## Additional Root Exports

The following are also re-exported from the root `@rdk-moss/agent` entry (index.ts):

### Built-in LLM Providers (native fetch, no SDK)

```ts
import { AnthropicLLMProvider, OpenAILLMProvider } from '@rdk-moss/agent'
import type { AnthropicLLMProviderConfig, OpenAILLMProviderConfig } from '@rdk-moss/agent'
```

- `AnthropicLLMProvider` — native Anthropic API adapter (index.ts:180-181)
- `OpenAILLMProvider` — native OpenAI API adapter (index.ts:182-183)

### MCP (Model Context Protocol client)

```ts
import { loadMcpConfig, connectMcpServers } from '@rdk-moss/agent'
import type { McpServerConfig, McpConfig, McpTool, McpConnection } from '@rdk-moss/agent'
```

- `loadMcpConfig()` — load MCP server configuration from file (index.ts:186)
- `connectMcpServers()` — establish connections to configured MCP servers (index.ts:186)

### ToolHookRegistry

```ts
import { ToolHookRegistry } from '@rdk-moss/agent'
import type { PreToolUseHook, PostToolUseHook, PostToolUseFailureHook, PreToolUseDecision } from '@rdk-moss/agent'
```

- `ToolHookRegistry` — pre/post tool execution hook pipeline (index.ts:281)

### Logger

```ts
import { createLogger, configureRootLogger, getRootLogger, redactSensitive } from '@rdk-moss/agent'
import type { LogLevel, LogEntry, Logger, LoggerOptions } from '@rdk-moss/agent'
```

Unified logging API aligned with `docs/logging.md` (index.ts:232-241).

### DmossError and ErrorCode

```ts
import { ErrorCode, DmossError, isDmossError, throwDmoss, wrapAsDmoss, formatDmossError, isDmossErrorRecoverable } from '@rdk-moss/agent'
import type { DmossErrorDetails } from '@rdk-moss/agent'
```

Actionable error classification API aligned with `docs/logging.md` (index.ts:244-253).

## What Is Not Stable

The following should be treated as **host-specific** or **internal**, unless separately documented:

- Host application HTTP routes and socket payloads
- CLI slash command syntax and UI controls for goal management
- Background or autonomous execution loops built around a stored goal
- Host-specific SDKs and orchestration engines
- Product-specific tool names and approval policies implemented by the host

## Compatibility Promise

For the current open-source phase, the intended compatibility promise is:

1. Root export names and documented subpath exports remain stable within a minor line
2. Removing or renaming exported symbols requires a major version bump
3. Host-specific integrations may evolve independently from the package API
