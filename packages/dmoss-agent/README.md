# @rdk-moss/agent

> **Moss is a ready-to-use terminal agent and embeddable robotics agent runtime developed by 地瓜机器人 (D-Robotics).**
> Install `moss`, log in with the D-Robotics developer community, and start with the built-in D-Robotics model gateway. Switch to your own OpenAI-compatible, Anthropic, private, or self-hosted model whenever you want.

The project is **Moss**. The npm package is **`@rdk-moss/agent`**. The primary CLI command is **`moss`**. `dmoss` remains a compatible alias for existing users and scripts.

<p align="center">
  <a href="#install"><img src="https://img.shields.io/npm/v/@rdk-moss/agent?logo=npm&color=ff6b00" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.16-brightgreen?logo=node.js&logoColor=white" alt="node >= 22.16" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  <img src="https://img.shields.io/badge/tests-200%2B%20passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/provider-agnostic-8a67f6" alt="provider-agnostic" />
</p>

```bash
npm i -g @rdk-moss/agent@latest
moss auth login
moss
```

<p align="center">
  <img src="./assets/moss-tui-demo.gif" alt="Moss terminal startup demo" width="720" />
</p>

<p align="center">
  <img src="./assets/moss-connect-vision.gif" alt="Moss board connection and image attachment demo" width="720" />
</p>

## Why Moss?

Moss gives you the familiar terminal-agent workflow of Claude Code and Codex, but keeps the runtime open, provider-flexible, and device-aware:

- **Built-in first run** - community login unlocks the D-Robotics gateway; no model API key is required to try the CLI.
- **Bring your own model** - DeepSeek, Qwen, OpenAI-compatible gateways, Anthropic, or self-hosted endpoints.
- **RDK board workflows** - `/connect <ip>` enables board SSH, diagnostics, and ROS2 tooling inside a live session.
- **Embeddable runtime** - use the Host Adapter contract to put Moss inside your own IDE, robot console, desktop app, or device platform.
- **Agent primitives included** - goals, compaction, sessions, attachments, MCP, skills, sub-agents, safety hooks, and tool execution.

If that ownership model matters to you, star the repo, fork it for your host, and open issues for providers, boards, or workflows you want Moss to cover next.

## Moss Vs Claude Code And Codex

| Capability | Moss | Claude Code | Codex |
| --- | --- | --- | --- |
| Interactive terminal agent | `moss` (`dmoss` alias) | yes | yes |
| Default first run | Built-in D-Robotics gateway after community login | Anthropic account | OpenAI account |
| Bring your own model | OpenAI-compatible, Anthropic, private gateways, self-hosted models | limited to Anthropic path | limited to OpenAI path |
| Robotics / board workflows | RDK board connect, SSH, diagnostics, ROS2 tool path | general developer agent | general developer agent |
| Embedding model | Public Host Adapter contract and npm packages | standalone product | standalone product |
| Product control | Host owns UI, tools, storage, approvals, credentials, telemetry | vendor-owned app | vendor-owned app |

Claude Code and Codex are excellent polished standalone assistants. Moss is for teams who want that style of agent while also owning the model route, device tools, product integration, and extension surface.

## Open-source scope (the harness)

**D-Moss is not “just an LLM wrapper”.** These packages ship a **reusable robotics Agent harness**: the tool loop, context governance (pruning / compaction), safety and approval hooks, session persistence, structured errors and retries, and pluggable `KnowledgeModule`s — so your application can focus on devices, UX, and policies.

| In `@rdk-moss/core` + `@rdk-moss/agent` | Outside the stable `@rdk-moss/*` API (host / product) |
|-----------------------------------|-----------------------------------------------------|
| Contracts, `DmossAgent`, `ToolRegistry`, hooks | HTTP/Socket APIs, desktop UI, SSH |
| Pruning, compaction, token budgeting | Your own installers, fleet routing, dashboards |
| `LLMProvider` (host implements; **recommended minimum integration**) | Your model transport (REST, WebSocket, local inference, etc.) |
| Optional `PiAiLLMProvider` (pi-ai-compatible stream bridge → `LLMProvider`) | Use only if you already build on pi-ai-style streams; otherwise skip in **your** code |
| Safety helpers, protected paths (host registers paths) | Concrete device tools and deployment scripts |
| Default robotics/domain prompts from `@rdk-moss/core` (tunable via `DmossAgent` config) | Product-specific prompts wired in `server/dmoss/*` (host) |
| Goal Mode runtime: goal state, agent methods, prompt injection | CLI slash commands, UI controls, approval policy, background execution |
| Observability helpers for tracing, usage logging, and redaction via `@rdk-moss/agent/observability` | Host-owned telemetry pipeline and exporters |
| Mesh event bus and orchestration helpers via `@rdk-moss/agent/mesh` | Ad hoc text parsing for child runs and peer events |

The open-source boundary is clean: `packages/dmoss/` + `packages/dmoss-agent/` in this monorepo are the stable public packages. Anything a host application builds on top (HTTP servers, desktop shells, SSH bridges, etc.) is the host's concern and not part of this package's public API.

**Docs:** [`API.md`](./API.md) · [`CHANGELOG.md`](./CHANGELOG.md)

### LLM integration: minimal path vs optional `pi-ai`

- **What you must implement:** `LLMProvider` — the only contract `DmossAgent` needs to call a model. **For the smallest integration surface and full control over HTTP/SDKs**, implement it yourself (often with **`fetch()` only**; no Anthropic/OpenAI SDK required). See the `LLMProvider` section in [`API.md`](./API.md) for the interface and a minimal implementation pattern.
- **What is optional:** **`PiAiLLMProvider`** — a convenience adapter for hosts that already use pi-ai-compatible streaming. You do **not** need to use it to ship a product on `@rdk-moss/agent`.
- **npm note:** `@rdk-moss/agent` no longer installs the deprecated pi-ai package family. The adapter keeps local compatibility types, so new installs avoid the old transitive warning chain while hosts can still supply a compatible stream function.

## Install

Requires **Node >= 22.16**.

### Use The CLI

```bash
npm i -g @rdk-moss/agent@latest
moss auth login
moss
```

`moss` uses the built-in D-Robotics model gateway after community login, so first use does **not** require a model API key. Run `moss setup` only when you want your own provider, account, private gateway, or self-hosted OpenAI-compatible model.

Each plain `moss` launch starts a **new saved conversation**. Continue previous history only when you ask for it:

```bash
moss resume --last
moss resume --session <key>
moss --session <key>
```

### Embed The Runtime

```bash
npm install @rdk-moss/agent@latest @rdk-moss/core@latest
```

Use this path when you are building a product host and want to supply your own UI, providers, tools, storage, approval gates, credentials, device access, and telemetry.

## Five-Minute CLI Tutorial

1. Start in a project:

   ```bash
   cd my-project
   moss
   ```

2. Ask for orientation:

   ```text
   Inspect this repo and tell me the build, test, and release path.
   ```

3. Check active state:

   ```text
   /status
   /model
   ```

4. Attach context:

   ```text
   /attach ./screenshot.png
   /attach ./error.log
   What is the likely issue?
   ```

   In the full macOS TUI, copy a screenshot and press `Ctrl+V`; Moss attaches it as `[Image #1]` for the next prompt.

5. Run a real task:

   ```text
   Fix the failing test, explain the root cause, and run the narrowest verification.
   ```

Interactive Moss asks before file writes, commands, and external actions unless you explicitly choose a more autonomous approval profile.

## Use Your Own Model

The built-in gateway is for immediate first use. Configure your own model when you need your own account, billing, private gateway, data-local deployment, or a self-hosted endpoint. Your local model config overrides the built-in gateway.

Guided setup:

```bash
moss setup
moss auth status
```

Environment variables:

```bash
export DEEPSEEK_API_KEY=...
# or: export OPENAI_API_KEY=...
# or: export ANTHROPIC_API_KEY=...
# or: export DASHSCOPE_API_KEY=...
moss
```

Private OpenAI-compatible gateway:

```bash
export OPENAI_API_KEY=...      # or DMOSS_API_KEY=... for a generic gateway key
moss config set provider openai-compatible
moss config set model <your-model>
moss config set baseUrl https://llm.example.com
moss auth status
moss
```

`baseUrl` is the API root, not the full chat endpoint. Do not include `/chat/completions`. Both `https://llm.example.com` and `https://llm.example.com/v1` are accepted; Moss calls `/v1/chat/completions` for OpenAI-compatible providers. If multiple provider keys are set in your shell, set `DMOSS_PROVIDER` explicitly.

Configuration priority is: CLI flags and `-c key=value` > environment variables > `moss config` / `moss setup` > built-in gateway.

Inside Moss, use `/model` to list models from the active provider when available, choose by number, or type `/model <model-name>` for a custom model.

## Connect An RDK Board

```text
/connect 192.168.1.10 --user root
/status
Check camera, ROS2 nodes, disk space, and device health.
```

`/connect` is session-scoped and does not require restarting Moss. The host still owns SSH credentials, protected paths, approval policy, and the concrete device tools that are exposed.

## Attach Images And Files

```text
/attach ./screenshot.png
/attach ./camera-frame.jpg
/attach ./notes.txt
Explain what you see and propose the next debug step.
```

Images (`png`, `jpg`, `jpeg`, `gif`, `webp`) are sent as model image blocks when the active provider/model supports vision. Text files are inserted as prompt context. Use `/attach list` to review pending attachments and `/attach clear` to discard them before sending.

## Useful CLI Commands

```
moss                 open the interactive TUI
moss "prompt"        run a one-shot prompt
moss auth login      sign in to the D-Robotics developer community
moss auth status     show community login and provider/model/key source
moss setup           configure your own provider/model/API key
moss config --help   show configuration commands
moss --help          show the focused CLI help
moss --help --all    show the complete CLI reference
```

Inside Moss:

```
/status      view model, workspace, device, and tool state
/model       list or choose active models
/goal        show or manage the persistent session goal
/compact     compress older conversation history into a summary
/attach      attach an image or text file to the next prompt
/connect     connect an RDK board for this session
/sessions    list saved conversations you can resume
/diff        show git working-tree changes
/auth login  log in to the D-Robotics developer community
/help        show focused command help
```

Advanced commands such as `/status --verbose`, `/context`, `/rewind`, `/tools`, `/permissions`, and `/memory` still work, but stay out of the default menu so the first screen remains usable.

## Automation And Browser Tools

```bash
DMOSS_CLI_AUTO_APPROVE=1 moss --workspace-write "write and verify the tool"
# or persist a broader local policy:
moss config set profile autonomous
```

`DMOSS_CLI_AUTO_APPROVE=1` only approves tools allowed by the active safety policy. It does not bypass `--read-only`, `deniedTools`, protected paths, or workspace sandbox checks. Browser workflows such as real checkout/add-to-cart testing use `web_browser_control`, which is an external interaction and needs `--full-access` plus approval.

`@rdk-moss/agent` includes `web_browser_fetch` and `web_browser_control` through `puppeteer-core`. It does not download a browser at install time. If Chrome or Chromium is not auto-discovered, configure the executable:

```bash
export DMOSS_BROWSER_EXECUTABLE="/path/to/chrome-or-chromium"
```

## Maintainer Tarball Smoke

From the monorepo root:

```bash
npm run smoke:moss-cli
```

The smoke script builds the workspace, packs the current `@rdk-moss/core`, `@rdk-moss/memory`, `@rdk-moss/skills`, and `@rdk-moss/agent` tarballs, installs them into a temporary project, checks the `moss` / `dmoss` / `dmoss-agent` bins, verifies packaged GIF and zero-config assets, blocks deprecated install warnings, and opens the TUI through a PTY when available.

## From Source

```bash
git clone <this-repo>
cd <this-repo>
npm install
npm run build -w @rdk-moss/agent
# A source checkout does not include the private npm zero-config gateway file.
# Configure your own model/provider, or set DMOSS_ZERO_CONFIG_DEFAULT_FILE for packaging tests.
node packages/dmoss-agent/dist/cli.js setup
node packages/dmoss-agent/dist/cli.js
node packages/dmoss-agent/dist/cli.js "check disk usage on /"
```

`setup` writes `~/.config/dmoss/config.json` with `0600` permissions and supports Aliyun/Qwen, OpenAI, Anthropic, and OpenAI-compatible providers. Your config overrides the built-in gateway. Config and keys can also come from environment variables, so secrets do not need to be written to disk.

`apply_patch` accepts Moss' structured patch format, not a raw `git apply` unified diff. Multi-file patches are supported, but each operation must be inside the documented `*** Begin Patch` / `*** Add File` / `*** Update File` / `*** Delete File` / `*** End Patch` blocks.

All flags also have env-var equivalents for logging and color control, including `DMOSS_LOG_LEVEL`, `DMOSS_LOG_JSON=1`, `DMOSS_NO_COLOR=1`, and `DMOSS_NO_UPDATE_CHECK=1`.

## Embed Moss In A Host

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

- **`LLMProvider` vs pi-ai-style streams:** The harness is built around **`LLMProvider`**. **`PiAiLLMProvider` is optional** — use it only if you want the pre-built compatibility bridge; otherwise prefer a **self-hosted `LLMProvider`** for minimal behavioral dependency (see [`API.md`](./API.md) for the interface).
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
