# @rdk-moss/agent

> **An AI agent runtime built for robotics and edge devices.**
> Pluggable LLMs, LAN-native Agent Mesh, framework-level tool-call self-healing, Chinese-first UX.

<p align="center">
  <a href="#install"><img src="https://img.shields.io/npm/v/@rdk-moss/agent?logo=npm&color=ff6b00" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.16-brightgreen?logo=node.js&logoColor=white" alt="node >= 22.16" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  <img src="https://img.shields.io/badge/tests-200%2B%20passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/provider-agnostic-8a67f6" alt="provider-agnostic" />
</p>

```bash
# Try it in 30 seconds
npx -y @rdk-moss/agent setup
npx -y @rdk-moss/agent "帮我检查当前目录"
```

## Why D-Moss

| D-Moss has | Most agent libs don't |
|---|---|
| ✅ **LAN Agent Mesh** — P2P peer discovery over UDP, zero cloud dependency | Relies on a central orchestrator |
| ✅ **Framework-level tool self-healing** — reconstructs `tool_use` from plan text when LLM stream drops `tool_calls` | Retries the whole turn or just fails |
| ✅ **Built-in ROS2 / device SSH / device diagnostics tools** | You wire these yourself |
| ✅ **Context compaction + steering + follow-up guard** out of the box | Single-loop prompt → response |
| ✅ **Thread Goal Mode** — session-backed goals injected into the system prompt | Untracked objective hidden in chat history |
| ✅ **Chinese as first-class locale** (prompts, errors, CLI) | English-only |
| ✅ **Board delegation** — run LLMs on an edge gateway, not the cloud | Cloud API only |

**D-Moss Agent** — a standalone, vendor-neutral robotics agent runtime.

Build AI-powered developer tools for any robotics platform with pluggable knowledge modules, tools, and LLM providers.

## Open-source scope (the harness)

**D-Moss is not “just an LLM wrapper”.** These packages ship a **reusable robotics Agent harness**: the tool loop, context governance (pruning / compaction), safety and approval hooks, session persistence, structured errors and retries, and pluggable `KnowledgeModule`s — so your application can focus on devices, UX, and policies.

| In `@rdk-moss/core` + `@rdk-moss/agent` | Outside the stable `@rdk-moss/*` API (host / product) |
|-----------------------------------|-----------------------------------------------------|
| Contracts, `DmossAgent`, `ToolRegistry`, hooks | HTTP/Socket APIs, desktop UI, SSH |
| Pruning, compaction, token budgeting | Your own installers, fleet routing, dashboards |
| `LLMProvider` (host implements; **recommended minimum integration**) | Your model transport (REST, WebSocket, local inference, etc.) |
| Optional `PiAiLLMProvider` (bridges `@mariozechner/pi-ai` → `LLMProvider`) | Use only if you already build on pi-ai streams; otherwise skip in **your** code |
| Safety helpers, protected paths (host registers paths) | Concrete device tools and deployment scripts |
| Default robotics/domain prompts from `@rdk-moss/core` (tunable via `DmossAgent` config) | Product-specific prompts wired in `server/dmoss/*` (host) |
| Goal Mode runtime: goal state, agent methods, prompt injection | CLI slash commands, UI controls, approval policy, background execution |
| Observability helpers for tracing, usage logging, and redaction via `@rdk-moss/agent/observability` | Host-owned telemetry pipeline and exporters |
| Mesh event bus and orchestration helpers via `@rdk-moss/agent/mesh` | Ad hoc text parsing for child runs and peer events |

The open-source boundary is clean: `packages/dmoss/` + `packages/dmoss-agent/` in this monorepo are the stable public packages. Anything a host application builds on top (HTTP servers, desktop shells, SSH bridges, etc.) is the host's concern and not part of this package's public API.

**Docs:** [`API.md`](./API.md) · [`CHANGELOG.md`](./CHANGELOG.md)

### LLM integration: minimal path vs optional `pi-ai`

- **What you must implement:** `LLMProvider` — the only contract `DmossAgent` needs to call a model. **For the smallest integration surface and full control over HTTP/SDKs**, implement it yourself (often with **`fetch()` only**; no Anthropic/OpenAI SDK required). See the `LLMProvider` section in [`API.md`](./API.md) for the interface and a minimal implementation pattern.
- **What is optional:** **`PiAiLLMProvider`** — a convenience adapter for hosts that already use **`@mariozechner/pi-ai`** streaming. You do **not** need to use it to ship a product on `@rdk-moss/agent`.
- **npm note:** `@rdk-moss/agent` currently **declares** `@mariozechner/pi-ai` as a runtime dependency so this adapter is always available when installed from npm. Your **application code** can still follow the minimal path by supplying only a custom `LLMProvider` and never importing `PiAiLLMProvider`. (A future optional split into `@rdk-moss/agent-pi-ai` would be a semver/major packaging decision.)

## Install

```bash
npm install @rdk-moss/agent@latest @rdk-moss/core@latest
```

Requires **Node ≥ 22.16** (see `engines` in `package.json`). One-off CLI tryout:

```bash
npx -y @rdk-moss/agent --help
```

### Path 2 — Local tarballs (maintainers / CI)

From the monorepo root:

```bash
npm pack --workspace=@rdk-moss/core
npm pack --workspace=@rdk-moss/agent
```

Install the generated `.tgz` files in a downstream project:

```bash
npm install ./dmoss-core-*.tgz ./dmoss-agent-*.tgz
```

Or run the CLI straight from a tarball:

```bash
npx -y ./dmoss-agent-*.tgz --help
```

### Path 3 — From source (contributors)

```bash
git clone <this-repo>
cd <this-repo>
npm install                 # links workspace packages (@rdk-moss/core, @rdk-moss/agent, create-dmoss-app)
npm run build -w @rdk-moss/agent
# Configure a model once:
node packages/dmoss-agent/dist/cli.js setup
# Then run the interactive REPL:
node packages/dmoss-agent/dist/cli.js
# Or one-shot mode:
node packages/dmoss-agent/dist/cli.js "check disk usage on /"
```

`setup` writes `~/.config/dmoss/config.json` with `0600` permissions and supports Aliyun/Qwen, OpenAI, Anthropic, and OpenAI-compatible providers. You can inspect or update the stored configuration without printing secrets:

```bash
dmoss-agent auth status
dmoss-agent auth logout
dmoss-agent config set model qwen3.7-max
dmoss-agent config set baseUrl https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode
dmoss-agent config set provider qwen
```

### CLI flags recap

```
setup                   guided first-run provider/model/API-key setup
auth status             show provider/model/key source without printing secrets
auth logout             remove stored API key from config
config set <key> <val>  update provider, model, or baseUrl
--debug                 verbose logging (level=debug)
--quiet                 only warnings & errors
--log-level=<lv>        debug | info | warn | error
--json                  emit structured JSON log lines
--no-color              disable ANSI colors
--help, -h              show the full usage page
--version, -v           show version
```

By default the CLI prints a short progress trail to stderr: planning turns, tool calls, and redacted tool results. The final assistant answer stays on stdout so shell piping still works. Tune this with `DMOSS_CLI_DETAIL=quiet|progress|verbose`; in the interactive REPL you can also run `/detail quiet`, `/detail progress`, or `/detail verbose`.

The interactive REPL starts with an onboarding panel that shows the active model, workspace, provider host, enabled capability groups, memory/skill counts, device status, and mesh status. Useful discovery commands:

```
/tools       show registered tools grouped by capability
/status      show model, workspace, runtime, device, and tool state
/examples    show prompts matched to the currently enabled capabilities
/detail      explain quiet/progress/verbose output modes
/upgrade     show install/update commands
/help        show interactive commands
```

All flags also available via env vars: `DMOSS_LOG_LEVEL`, `DMOSS_LOG_JSON=1`, `DMOSS_NO_COLOR=1`.

## Quick Start

```typescript
import { DmossAgent, InMemorySessionStore } from '@rdk-moss/agent';
import type { LLMProvider, AgentHooks } from '@rdk-moss/agent';

// 1. Implement your LLM provider (Anthropic, OpenAI, etc.)
const myProvider: LLMProvider = { /* ... */ };

// 2. Create the agent
const agent = new DmossAgent({
  llmProvider: myProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
  hooks: {
    onBeforeToolExec: async (req) => ({ approved: true }),
    onStream: (event) => console.log(event),
  },
});

// 3. Register knowledge for your hardware
import type { KnowledgeModule } from '@rdk-moss/core';
const myKnowledge: KnowledgeModule = { /* ... */ };
agent.registerKnowledge(myKnowledge);

// 4. Register tools
agent.tools.register({
  name: 'device_exec',
  description: 'Execute a command on the connected device',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async (input) => { /* ... */ },
});

// 5. Chat
const result = await agent.chat('session-1', 'Check the camera status', {
  platform: 'my-board-v1',
});
console.log(result.response);
```

## Architecture

```
@rdk-moss/core      → Contracts (KnowledgeModule, PlatformExtension, VendorPlugin, etc.)
@rdk-moss/agent     → Runtime (this package)
  ├── DmossAgent         — Central orchestrator (chat loop, tool execution, hooks)
  ├── ToolRegistry       — Pluggable tool registration and discovery
  ├── Knowledge Registry — Domain knowledge aggregation from all modules
  ├── Extension System   — Platform extension lifecycle management
  ├── Safety             — Secret sanitization, dangerous command detection
  ├── Skills             — SKILL.md scanning and matching
  ├── Session            — JSONL session persistence + in-memory option
  ├── Goal Mode          — Session-backed thread goals for prompt context
  ├── Context            — Pruning, compaction, token estimation
  ├── Provider           — Error classification, retry with exponential backoff
  ├── Prompts            — Robotics engineering prompts, telemetry
  └── Utils              — Stream smoother, trace logging, abort signals
```

## Public API

### Core

| Export | Type | Description |
|--------|------|-------------|
| `DmossAgent` | class | Central agent orchestrator |
| `ToolRegistry` | class | Register/discover/group tools |
| `InMemorySessionStore` | class | Built-in session store |
| `SkillRegistry` | class | SKILL.md scanner |

### Interfaces (implement these in your host)

| Interface | Description |
|-----------|-------------|
| `LLMProvider` | Abstract LLM interaction (Anthropic, OpenAI, etc.) |
| `SessionStore` | Session persistence (file, database, in-memory) |
| `AgentHooks` | Lifecycle hooks (approval, events, context enrichment) |

### Types

| Type | Description |
|------|-------------|
| `Tool<T>` | Tool definition with inputSchema and execute |
| `ToolContext` | Execution context (workspace, session, abort) |
| `ToolCall` / `ToolResult` | Tool invocation and response |
| `LLMMessage` / `LLMContentBlock` | LLM message types |
| `ChannelSafetyResult` | Command safety check result |
| `SkillMeta` | Skill metadata |
| `GoalState` | Thread goal with objective, status, and timestamps |
| `GoalStatus` | Goal lifecycle status (`active`, `paused`, `completed`, `blocked`) |

### Runtime capabilities

| Capability | Description |
|------------|-------------|
| Goal Mode | `DmossAgent` can set, view, pause, resume, complete, block, and clear a session goal, then inject active or paused goal context into the system prompt |

### Functions

| Function | Description |
|----------|-------------|
| `registerKnowledgeModule()` | Register a hardware knowledge module |
| `findModuleForPlatform()` | Find knowledge for a specific platform |
| `getAllDeviceProfiles()` | Aggregate all device profiles |
| `buildRoboticsEngineeringPrompt()` | Generic robotics system prompt |
| `sanitizeSecrets()` | Mask API keys in text |
| `isCommandDangerous()` | Check shell commands for safety |

## Streaming API

For real-time UI integration, use `streamChat()` which yields events as they occur:

```typescript
for await (const event of agent.streamChat('session-1', 'Check camera')) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_start':
      console.log(`Running tool: ${event.toolName}`);
      break;
    case 'tool_end':
      console.log(`Tool ${event.toolName}: ${event.isError ? 'FAILED' : 'OK'}`);
      break;
    case 'done':
      console.log(`\nCompleted: ${event.result.toolCalls.length} tool calls`);
      break;
  }
}
```

## Hooks System

```typescript
const hooks: AgentHooks = {
  // Tool approval (block dangerous operations)
  onBeforeToolExec: async (req) => {
    if (isDangerous(req.input)) return { approved: false, reason: 'Blocked' };
    return { approved: true };
  },
  // Audit logging
  onToolResult: (call, result) => auditLog(call, result),
  // Raw provider stream telemetry. For product UI text, consume streamChat() events.
  onStream: (event) => console.debug('provider stream', event.type),
  // Error handling
  onError: async (err, ctx) => isRetryable(err),
  // Inject host-specific context
  enrichToolContext: (ctx, key) => ({ ...ctx, deviceId: getDevice(key) }),
};
```

## Goal Mode

D-Moss provides **thread-level goal tracking** without autonomous background execution. The runtime stores one goal per session in the configured `SessionStore` and injects active or paused goal context into the system prompt during chat turns.

For host integrations that want a thin command router, `@rdk-moss/agent/goal` exposes a stable `/goal` adapter with `isGoalCommand()`, `parseGoalCommand()`, `executeGoalCommand()`, and `handleGoalCommand()`. Results are structured, so hosts can echo `message` now and map `action`/`event` into UI or observability later.

```typescript
// Host sets the goal; the runtime stores it in session state.
await agent.setGoal('session-1', 'Migrate CI pipeline to GitHub Actions');

const goal = await agent.getGoal('session-1');

// Host controls the lifecycle.
await agent.pauseGoal('session-1', 'waiting for reviewer feedback');
await agent.resumeGoal('session-1');
await agent.completeGoal('session-1', 'verified in CI');
// Or: await agent.blockGoal('session-1', 'blocked on missing credentials');
await agent.clearGoal('session-1');
```

Goals are bound to the exact `sessionKey` passed in by the host. Subagents, mesh peer queries, and external channel sessions should use their own session keys unless the host explicitly wants goal inheritance. Hosts own the product behavior around this API: routing, UI controls, approval workflows, and any background execution loop. `@rdk-moss/agent` only stores the goal and surfaces it to the model as runtime guidance.

## Adding a New Hardware Platform

Implement the `KnowledgeModule` interface from `@rdk-moss/core` for your hardware platform.

```typescript
import type { KnowledgeModule } from '@rdk-moss/core';

const jetsonKnowledge: KnowledgeModule = {
  id: 'jetson',
  name: 'NVIDIA Jetson',
  version: '1.0.0',
  description: 'Jetson developer kit knowledge',
  platforms: ['jetson-nano', 'jetson-orin'],
  getDeviceProfiles: () => ({ /* ... */ }),
  getDocIndex: () => [],
  getPromptFragments: () => [{ id: 'cuda-tips', /* ... */ }],
  getCommandPatterns: () => [{ pattern: /tegrastats/i, /* ... */ }],
  getFailureHints: () => [{ errorPattern: /CUDA out of memory/i, /* ... */ }],
  getEcosystemPrompt: () => '## NVIDIA Jetson\n...',
};

agent.registerKnowledge(jetsonKnowledge);
```

## Known Limitations

- **`LLMProvider` vs `pi-ai`:** The harness is built around **`LLMProvider`**. **`PiAiLLMProvider` + `@mariozechner/pi-ai` are optional** — use them only if you want the pre-built pi-ai bridge; otherwise prefer a **self-hosted `LLMProvider`** for minimal behavioral dependency (see [`API.md`](./API.md) for the interface).
- **Robotics prompt injected by default**: `DmossAgent.buildSystemPrompt()` includes the robotics engineering prompt from `@rdk-moss/core` unless opted out. Non-robotics hosts can set `domainPrompt: false` to skip it, or provide a custom `domainPrompt: () => string` to replace it with domain-specific guidance.
- **Vendor plugin callbacks**: new hosts should call `agent.extensions.setVendorPluginCallbacks()` before `agent.extensions.apply()` to keep vendor plugins scoped to one agent. Legacy hosts may still use the process-scoped `setVendorPluginCallbacks()` / `applyPlatformExtension()` wrappers during migration.
- **Publishing**: The Moss stack is prepared as publishable npm workspaces. Before a release, run `npm run verify` from the repo root; it covers OSS boundary checks, workspace hygiene, workspace builds, typechecks, and package tests. Use the release checklist for host consumption validation.

## Documentation

- [API.md](./API.md) — stable public API surface, event model, and import recommendations
- [USAGE.md](./USAGE.md) — extended usage examples and host integration patterns
- [CONTRIBUTING.md](./CONTRIBUTING.md) — package-specific contribution guide
- [SECURITY.md](./SECURITY.md) — vulnerability reporting and security scope

## API Stability

The stable open-source surface of `@rdk-moss/agent` is the package export map defined in `package.json` and documented in [API.md](./API.md).

Host-level routes and product integrations belong to the embedding application and should not be treated as the public API of this package.

### `@internal` symbols

Some exports are marked with `/** @internal */` JSDoc comments. These are **implementation details** that are exported only for internal use within the `@rdk-moss/*` package family. They are **not part of the stable public API** and may change or be removed in any release (including patch releases) without notice or migration path.

If you depend on an `@internal` symbol, you are opting out of semver protections. Prefer the documented public API surface in [API.md](./API.md).

## License

[MIT](./LICENSE)
