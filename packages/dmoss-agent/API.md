# @dmoss/agent API Reference

This document defines the **stable public API surface** of `@dmoss/agent`.

The source of truth is:

1. `packages/dmoss-agent/package.json` export map
2. Root exports in `src/index.ts`
3. Subpath exports in `src/*/index.ts`

Anything a host application builds on top (HTTP servers, frontends, desktop shells, SSH bridges, fleet dashboards, etc.) is the host's concern and is **not** part of the stable API of this package.

**Agent harness:** The exports below are the **harness** around your LLM (tools, context, safety, sessions, retries) — not a full product.

## Installation

```bash
npm install @dmoss/agent @dmoss/core
```

## Stable Import Paths

| Import path | Purpose |
|------------|---------|
| `@dmoss/agent` | Main entry: `DmossAgent`, knowledge helpers, safety, provider, utils |
| `@dmoss/agent/core` | Core runtime types and lower-level APIs |
| `@dmoss/agent/context` | Context window, truncation, compaction helpers |
| `@dmoss/agent/provider` | Provider adapter and retry/error helpers |
| `@dmoss/agent/safety` | Secret masking, command/path safety |
| `@dmoss/agent/knowledge` | Knowledge registry access |
| `@dmoss/agent/extensions` | Platform extension lifecycle |
| `@dmoss/agent/prompts` | Prompt telemetry helpers |
| `@dmoss/agent/skills` | Skill registry |
| `@dmoss/agent/utils` | Text smoothing, tracing, env helpers |
| `@dmoss/agent/tools/builtin` | Built-in filesystem/shell/search tools |
| `@dmoss/agent/mesh` | Multi-agent mesh (HTTP + LAN discovery) |

## API stability labels

These labels describe **semver intent** for `@dmoss/agent` **only** (not any embedding host application).

| Label | Meaning |
|-------|---------|
| **Stable** | Symbols reachable through `package.json` `exports` **and** listed in this file (or package `README.md`) for that major line. Breaking removals/renames require a **major** bump. |
| **Experimental** | May change in a minor release. Today this is reserved for features explicitly called out in `CHANGELOG.md` as experimental; if none are listed, treat all documented exports as **Stable**. |
| **Internal** | Anything not re-exported from the supported entry points (e.g. deep imports into `src/...` paths, or host code under `server/`). **Do not rely on these.** |

**Practical rule:** import only from documented paths in the table above; run `npm test --workspace=@dmoss/agent` when adding exports.

## Main Runtime API

### `DmossAgent`

The primary runtime class.

```ts
import { DmossAgent, InMemorySessionStore } from '@dmoss/agent'
import type { LLMProvider } from '@dmoss/agent'

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
| `steeringEvents` | `string[]` | Fired steering guidance |
| `stopReason` | `'max_turns_reached' \| 'tool_followup_cap_reached'` | Early termination reason |

## Event Model

There are **three different event layers** in the package. This distinction matters for host integrations.

### 1. `DmossAgentEvent`

Returned by `agent.streamChat()`:

```ts
type DmossAgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; input: Record<string, unknown> }
  | { type: 'tool_end'; toolName: string; toolCallId: string; result: string; isError: boolean; aborted?: { by: 'user' | 'timeout' } }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; stopReason: string }
  | { type: 'error'; error: string; retriable: boolean }
  | { type: 'compaction'; summaryChars: number; droppedMessages: number; checkpointOutline?: string[] }
  | { type: 'working_context_checkpoint'; status: string; reason: string; goal: string; nextAction: string }
  | { type: 'steering'; pendingCount: number; firedRules: string[] }
  | { type: 'follow_up'; guidance: string }
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

Available from `@dmoss/agent/core`. This is a lower-level internal runtime event union used by the agent loop and advanced hosts.

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
import type { AgentHooks } from '@dmoss/agent'

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
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  execute: (input: TInput, ctx: ToolContext) => Promise<string>
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
  complete(options: LLMRequestOptions): Promise<LLMResponse>
  stream(options: LLMRequestOptions, onEvent: (event: LLMStreamEvent) => void): Promise<LLMResponse>
  countTokens?(text: string): Promise<number>
}
```

### Optional built-in adapter (`pi-ai`)

`PiAiLLMProvider` is an **optional** bridge for hosts that already integrate **`@mariozechner/pi-ai`**. You do **not** need to import or construct it unless you choose that stack.

The `@dmoss/agent` package **depends on** `@mariozechner/pi-ai` at install time so this adapter is always resolvable from npm; your application can still use **only** a custom `LLMProvider` and never reference `PiAiLLMProvider`.

```ts
import { PiAiLLMProvider } from '@dmoss/agent'
```

## Session API

Built-in stores:

- `InMemorySessionStore`
- `JsonlSessionStore`

Session helpers available from `@dmoss/agent/core`:

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

Call these **once at startup** in your host application so product-specific tool names and limits are wired into the harness without forking `@dmoss/agent`:

| Function | Module | Purpose |
|----------|--------|---------|
| `registerProtectedPaths()` | `@dmoss/agent` / `@dmoss/agent/safety` | Extra paths that must not be read/written by tools |
| `registerToolOutputLimits()` | `@dmoss/agent/context` | Per-tool output truncation caps |
| `registerMutatingToolHints()` | `@dmoss/agent/core` | Extra tool names/prefixes treated as mutating for idempotent replay |
| `setOpenUrlMarkers()` | `@dmoss/agent/core` | Success/failure substrings in open-URL tool results (for `web_fetch` suppression) |
| `registerNonMainChannelPrefixes()` | `@dmoss/agent/context` | Channel prefixes for non-main sessions |
| `registerSpawnToolExtensions()` | `@dmoss/agent/core` | Extra tool names allowed for sub-agent spawns |
| `setVendorPluginCallbacks()` | `@dmoss/agent` | Vendor plugin lifecycle hooks |

Hosts register these at startup (before instantiating `DmossAgent`) via a small bridge module tailored to their product. Example: a Node host might call `setVendorPluginCallbacks(...)` and `registerProtectedPaths(...)` in its server bootstrap.

## Safety API

Exported from `@dmoss/agent/safety` (a subset is also re-exported from the root package):

- `sanitizeSecrets()`
- `containsSecrets()`
- `isCommandDangerous()`
- `isPathProtected()`
- `registerProtectedPaths()`
- `matchTextApproval()`
- `classifyFileKind()`
- `stripShellPrefixBeforeHeredoc()`
- `resolveSandboxPath()` — **only from `@dmoss/agent/safety`**
- `assertSandboxPath()` — **only from `@dmoss/agent/safety`**

## Agent Mesh

Exported from `@dmoss/agent/mesh`:

- `AgentMesh` — multi-agent peer discovery and communication
- `createMeshTools()` — create mesh-backed tools for agent collaboration
- `isMeshVerboseEnabled()` — check verbose logging flag
- `LanDiscovery` — LAN peer discovery via UDP broadcast
- Types: `MeshConfig`, `MeshPeer`, `MeshMessage`

## Context API

Exported from `@dmoss/agent/context`:

- `resolveContextWindowInfo()`
- `evaluateContextWindowGuard()`
- `getEffectiveContextWindowTokens()`
- `truncateToolOutput()`
- `registerToolOutputLimits()`
- `compactSubagentSummaryForParent()`

## Built-in Tools

Exported from `@dmoss/agent/tools/builtin`:

- `readFileTool`
- `writeFileTool`
- `listDirectoryTool`
- `execTool`
- `searchFilesTool`
- `builtinTools`
- `registerBuiltinTools()`

These are useful for minimal standalone hosts and CLI prototypes.

### Web Fetch Tool

Exported from `@dmoss/agent` (root):

- `createWebFetchTool(opts?: WebFetchOptions): Tool`

HTTP(S) fetch tool with SSRF protection, size limits, and HTML-to-text cleanup.

## Provider stream errors (implementation note)

`PiAiLLMProvider`（`@dmoss/agent/provider`）在 pi-ai 流式 `type=error` 且缺少可见 `content`、仅带 `errorMessage` 时，会把它作为 provider/runtime 错误抛出，不能写入 assistant `text` block。宿主应在错误路径用 `src/provider/error-classify.ts`（`classifyProviderError`、`renderProviderErrorSurface`、`sanitizeRawErrorForDetail`）生成结构化错误 UI 或渠道 fallback，避免把“模型暂时不可用”归档成正常回答。

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

## What Is Not Stable

The following should be treated as **host-specific** or **internal**, unless separately documented:

- Host application HTTP routes and socket payloads
- Host-specific SDKs and orchestration engines
- Product-specific tool names and approval policies implemented by the host

## Compatibility Promise

For the current open-source phase, the intended compatibility promise is:

1. Root export names and documented subpath exports remain stable within a minor line
2. Removing or renaming exported symbols requires a major version bump
3. Host-specific integrations may evolve independently from the package API
