# @rdk-moss/agent

**English** · [简体中文](README.zh-CN.md)

> **The Moss agent runtime.** Install `moss` to use the terminal agent, or `npm install` to embed a robotics-aware agent — tool loop, context governance, safety hooks, sessions, and pluggable knowledge — inside your own product.

Made by 地瓜机器人 (D-Robotics). The project is **Moss**; the package is **`@rdk-moss/agent`**; the CLI is **`moss`** (`dmoss` is a compatible alias).

<p align="center">
  <a href="#install"><img src="https://img.shields.io/npm/v/@rdk-moss/agent?logo=npm&color=ff6b00" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.16-brightgreen?logo=node.js&logoColor=white" alt="node >= 22.16" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  <img src="https://img.shields.io/badge/provider-agnostic-8a67f6" alt="provider-agnostic" />
</p>

<p align="center">
  <img src="./assets/moss-tui-demo.gif" alt="Moss terminal startup demo" width="720" />
</p>

This package is two things in one:

- **A terminal agent** — `npm i -g @rdk-moss/agent`, run `moss`, work immediately on the built-in D-Robotics gateway (no model key, no forced login).
- **An embeddable runtime** — `npm install @rdk-moss/agent @rdk-moss/core`, then drive `DmossAgent` from your own host with your providers, tools, storage, and approval policy.

> **Not just an LLM wrapper.** The harness owns the tool loop, context pruning/compaction, safety/approval hooks, session persistence, structured errors and retries, and pluggable `KnowledgeModule`s — so your application can focus on devices, UX, and policy. The stable public surface is `packages/dmoss/` + `packages/dmoss-agent/`; everything a host builds on top (HTTP servers, desktop shells, SSH bridges) stays outside this package's API.

## Install

Requires **Node ≥ 22.16**.

```bash
npm i -g @rdk-moss/agent@latest    # CLI
# or
npm install @rdk-moss/agent@latest @rdk-moss/core@latest   # embed
```

## Use The CLI

```bash
moss                       # interactive TUI on the built-in gateway
moss "check disk usage"    # one-shot
moss setup                 # configure your own provider / model / key
```

The full CLI guide — model setup, board connect, long-running tasks, automation, safety, and skills — lives in the [project README](../../README.md). The essentials:

```bash
moss resume --last         # continue the most recent saved session
moss --session work        # continue or create a named session
moss doctor                # health-check config, auth, workspace, board, MCP (non-zero exit on failure)
moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data
```

`/connect <ip>` puts a live session onto an RDK board over SSH (board mode: device + ROS2 tools), and `/disconnect` restores local tools. On an RDK board, teach Moss the whole stack with the [device-knowledge](https://github.com/D-Robotics/device-knowledge) skill pack — see [Give Moss RDK Board Skills](../../README.md#give-moss-rdk-board-skills).

Most-used in-session commands (type `/help` for all):

```
/status /model              model, workspace, device, and tool state · choose models
/connect /disconnect        connect an RDK board and enter board mode · leave it
/sessions /resume           list saved conversations · switch into one ([key|--last])
/goal /compact /attach      goal runner · compress history · attach an image/file
/mcp /doctor /diff /yolo    MCP status · health-check · changes · full-power session
```

## Embed The Runtime

Implement one interface — `LLMProvider` — and drive the agent. For the smallest surface and full control, implement it yourself with `fetch()` only (no Anthropic/OpenAI SDK required); `PiAiLLMProvider` is an optional convenience bridge for hosts already on pi-ai-style streams.

```typescript
import { DmossAgent, InMemorySessionStore } from '@rdk-moss/agent';
import type { LLMProvider } from '@rdk-moss/agent';

const myProvider: LLMProvider = { /* call your model (fetch is enough) */ };

const agent = new DmossAgent({
  llmProvider: myProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
  hooks: {
    onBeforeToolExec: async (req) => ({ approved: true }),  // your approval policy
    onToolResult: (call, result) => auditLog(call, result),
  },
});

// Register tools and hardware knowledge for your platform.
agent.tools.register({
  name: 'device_exec',
  description: 'Execute a command on the connected device',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async (input) => { /* ... */ },
});

const result = await agent.chat('session-1', 'Check the camera status', { platform: 'my-board-v1' });
console.log(result.response);
```

For real-time UIs, stream events instead:

```typescript
for await (const event of agent.streamChat('session-1', 'Check camera')) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  if (event.type === 'tool_start') console.log(`tool: ${event.toolName}`);
  if (event.type === 'done') console.log(`\n${event.result.toolCalls.length} tool calls`);
}
```

### Key API surface

| Implement in your host | Purpose |
| --- | --- |
| `LLMProvider` | The only contract `DmossAgent` needs to call a model |
| `SessionStore` | Session persistence (file, database, in-memory) |
| `AgentHooks` | Lifecycle hooks: approval, audit, events, context enrichment |
| `KnowledgeModule` (`@rdk-moss/core`) | Device profiles, prompts, command patterns, and failure hints for a hardware platform |

| Use from the runtime | Purpose |
| --- | --- |
| `DmossAgent` | Central orchestrator: chat loop, tool execution, hooks, goal state |
| `ToolRegistry` | Register / discover / group tools |
| `InMemorySessionStore` | Built-in session store |
| `SkillRegistry` | `SKILL.md` scanner |

`DmossAgent` also tracks one **goal** per session (`setGoal` / `pauseGoal` / `completeGoal` / `blockGoal` / `clearGoal`) and injects it into the system prompt; the `moss` CLI builds its `/goal` runner on that state. Subpath entries `@rdk-moss/agent/goal`, `/observability`, and `/mesh` expose the goal adapter, tracing/redaction helpers, and the mesh event bus.

The full public surface — every type, event, and import recommendation — is documented in [`API.md`](./API.md), with extended patterns in [`USAGE.md`](./USAGE.md).

## Honest Runtime Behavior

Each run injects a compact capability layer into the system prompt: the tool names actually registered for this run (so the model uses real tools, not guesses), MCP/CodeGraph status from what registered (CodeGraph is only recommended when `codegraph_*` tools are present), and a 实事求是 behavior contract — separate verified facts from inference and assumptions, say when evidence is missing, and never claim a result without a check behind it.

## Configure Your Own Model

```bash
moss config set provider openai-compatible
moss config set model <your-model>
moss config set baseUrl https://llm.example.com   # API root, not /chat/completions
moss setup                                          # stores the key (hidden prompt)
```

Supported: `deepseek`, `qwen`, `openai`, `anthropic`, `openai-compatible`. Settings live in moss config only — env vars like `OPENAI_API_KEY` / `DMOSS_PROVIDER` are deliberately ignored so a key exported for another tool never silently switches your provider (`moss doctor` lists leftovers). For scripts/CI, pass `moss --config-file /path/to/config.json`. Priority: CLI flags / `-c key=value` > project `.moss/config.json` > `moss config` > built-in gateway.

## From Source

```bash
git clone https://github.com/D-Robotics/moss && cd moss
npm install
npm run build -w @rdk-moss/agent
node packages/dmoss-agent/dist/cli.js   # A source checkout omits the private zero-config gateway; run `setup` or set your own provider.
```

Maintainers validate a release with `npm run verify` (OSS-boundary + hygiene checks, build, typecheck, lint, tests) and `npm run smoke:moss-cli` (packs the tarballs, installs into a temp project, and checks the bins and packaged assets).

## API Stability

The stable surface is the export map in `package.json`, documented in [`API.md`](./API.md). Host-level routes and product integrations belong to the embedding application, not this package's public API. Exports marked `/** @internal */` are implementation details — not semver-protected, and may change in any release. Prefer the documented surface in [`API.md`](./API.md).

## Documentation

- [`API.md`](./API.md) — stable public API, event model, import recommendations
- [`USAGE.md`](./USAGE.md) — extended usage and host-integration patterns
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — package contribution guide
- [`SECURITY.md`](./SECURITY.md) — vulnerability reporting and security scope
- [`CHANGELOG.md`](./CHANGELOG.md) — release history

## License

[MIT](./LICENSE)
