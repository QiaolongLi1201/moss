# Moss

**Moss is an open, robotics-aware terminal agent and embeddable agent runtime developed by 地瓜机器人 (D-Robotics).** Run `moss` and start working immediately on the built-in D-Robotics model gateway — no model API key and no forced login. When you want your own model, billing, data boundary, or private gateway, point Moss at any OpenAI-compatible endpoint or Anthropic without changing the agent.

`moss` is the primary command. `dmoss` remains a compatible alias for existing users and scripts.

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-tui-demo.gif" alt="Moss terminal startup demo" width="720" />
</p>

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-connect-vision.gif" alt="Moss board connection and image attachment demo" width="720" />
</p>

## Quick Start

```bash
npm i -g @rdk-moss/agent@latest
moss
```

The npm package is `@rdk-moss/agent`; the command is `moss`. Node 22.16 or newer is required. The first launch works out of the box on the built-in gateway — ask it something and it answers. `moss auth login` is optional and only links a D-Robotics developer community account.

You can also run Moss without entering the interactive UI:

```bash
moss "check disk usage on this project"   # one-shot: answer and exit
echo "list the failing tests" | moss      # piped stdin
moss -m qwen-plus "summarize @README.md"  # override the model for one run; @path attaches a file
```

Update anytime with `npm i -g @rdk-moss/agent@latest`, or `/upgrade` from inside Moss.

## Why Moss

Moss gives you the familiar terminal-agent loop from Claude Code and Codex with a different ownership model:

- **Use it immediately** — the built-in D-Robotics gateway works with no model key and no forced community login.
- **Bring your own model** — DeepSeek, Qwen, any OpenAI-compatible gateway, Anthropic, or a self-hosted endpoint. Switching providers never changes the agent.
- **Work with robots and edge devices** — `/connect <ip>` puts the whole session on an RDK board over SSH, with diagnostics and ROS2 tools, then `/disconnect` restores local tools.
- **Survive long, interruptible work** — sessions are saved as you go, a working-context checkpoint tracks the active task, and `moss resume`/`--continue` pick the task back up instead of restarting it.
- **Stay honest about evidence** — Moss is prompted to separate verified facts, inferences, and assumptions, to report when CodeGraph or device access is unavailable, and to never claim a result it did not verify.
- **Embed it in your own product** — Moss is a runtime with public contracts and npm packages, not only a closed standalone app.

If that direction is useful, star the repo to follow the open runtime, fork it to build your own host, and open issues for model providers, board workflows, or host-adapter gaps you want Moss to support.

## Moss Vs Claude Code And Codex

| Capability | Moss | Claude Code | Codex |
| --- | --- | --- | --- |
| Interactive terminal agent | `moss` (`dmoss` alias) | yes | yes |
| Default first run | Built-in D-Robotics gateway, no model key or forced login | Anthropic account | OpenAI account |
| Bring your own model | OpenAI-compatible, Anthropic, private gateways, self-hosted models | Anthropic path | OpenAI path |
| Robotics / board workflows | First-class RDK board connect, SSH, diagnostics, ROS2 tools | general developer agent | general developer agent |
| Embedding model | Public Host Adapter contract and npm packages | standalone product | standalone product |
| Product control | Host owns UI, tools, storage, approvals, credentials, telemetry | vendor-owned app | vendor-owned app |

Claude Code and Codex are excellent polished standalone assistants. Moss is for people who want that style of agent while also owning the runtime, model route, device tools, and product integration surface.

## A Five-Minute Tour

1. Open a project and start Moss:

   ```bash
   cd my-project
   moss
   ```

2. Ask for a read-only orientation, then check the runtime state:

   ```text
   Inspect this repo and tell me the build, test, and release path.
   /status
   /model
   ```

3. Attach context (drag a path in, or use `/attach`); on the macOS TUI you can copy a screenshot and press `Ctrl+V`:

   ```text
   /attach ./screenshot.png
   What is wrong in this UI?
   ```

4. Give Moss a concrete task. It asks before file writes, commands, and external actions unless you choose a more autonomous policy:

   ```text
   Fix the failing test, explain the root cause, and run the narrowest verification.
   ```

## Interactive Commands

Inside a session, type `/help` for the full list. The commands you will use most:

| Command | Purpose |
| --- | --- |
| `/status` | Model, login, workspace, board target, and tool state |
| `/model` · `/models` | Switch the active model, or list models for the provider |
| `/sessions` · `/resume [key\|--last]` | List saved conversations, and switch into one |
| `/connect <ip>` · `/disconnect` | Enter / leave board mode for an RDK device |
| `/goal <condition>` | Run until a goal condition is met (goal runner) |
| `/compact` | Compress older history into a summary to free context |
| `/attach <path>` | Attach an image or text file to the next prompt |
| `/diff` · `/review` | Show working-tree changes, or review them for bugs/safety |
| `/mcp` · `/doctor` | Inspect MCP servers, or health-check the session |
| `/memory` · `/skills` | Show stored long-term memory, or available/learned skills |
| `/yolo` | Grant full power for this session — no per-call approval (`/yolo off` reverts) |
| `/clear` | Start a new conversation (clears the context window) |

You can also press **Shift+Tab** to cycle the interaction mode (see [Automation And Safety](#automation-and-safety)).

## Long-Running Tasks And Resume

Moss is built to survive long, interruptible work rather than restart from zero.

Every plain `moss` launch is a new saved conversation. Pick history back up only when you ask:

```bash
moss resume --last            # continue the most recent saved session
moss resume --session <key>   # continue a specific session
moss --session work           # continue or create a named session
moss --continue "keep going"  # one-shot that auto-resumes the latest session
moss fork --last              # branch a copy of a session without touching the original
```

Use `/sessions` to list saved conversations and `/resume [key|--last]` to switch into one without leaving Moss. The session pickers show a title derived from the first message, so a saved session is recognizable instead of a bare `cli-<timestamp>` key.

Within a run, Moss keeps a working-context checkpoint of the active task — goal, completed and pending steps, important paths, and recent tool findings. If a run is interrupted — a tool-loop guard fires, a tool errors, or the turn budget is reached — the task is marked **resumable** instead of lost, the CLI tells you it stopped before finishing and how to continue, and the saved context is re-injected on the next turn. Saying `continue` / `继续` (or running `/goal`) resumes from that checkpoint and avoids repeating finished steps rather than starting over. Compaction preserves the goal and pending steps, so long tasks keep their thread even after older history is summarized.

For multi-step work you can also hand Moss an explicit goal and let it drive:

```text
/goal migrate this repo to the new package name and verify the build
```

The goal runner keeps working until the goal is completed, blocked, cleared, or stopped. Per-request tool-loop budgets are opt-in host/user limits.

## Connect An RDK Board

Use `/connect` inside a live session; no restart is required:

```text
/connect 192.168.1.10 --user root
/connect ubuntu@192.168.1.10 --port 2222 --key ~/.ssh/id_rsa
/status
Check camera, ROS2 nodes, disk space, and device health.
```

`/connect` verifies SSH reachability and credentials before enabling device tools; if the probe fails it reports why and the tools stay disabled. Pass `--no-verify` to register tools without probing (e.g. a board that is about to boot).

After a verified connect the session enters **board mode**: the default tools (`exec`, `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `search_code`, `move_file`) run on the board over SSH, so working in Moss feels like running it on the board itself. ROS2 tools (`ros2_topic_list`, `ros2_topic_echo`, `ros2_node_list`, `ros2_service_call`, `ros2_launch`, …) and `device_*` diagnostics become available, and honor the board's `ROS_DOMAIN_ID` when one is configured. Leave board mode with `/disconnect` or Ctrl+D on an empty prompt — local tools are restored exactly as they were. Pass `--hybrid` to keep the local tools and only add the `device_*` / `ros2_*` tools alongside.

The host still controls SSH credentials, approval policy, protected paths, and available device tools. Device and ROS tools require host-side `ssh`/`sshpass` and execute Linux commands on the remote device rather than on your workstation.

## Attach Images And Files

```text
/attach ./screenshot.png
/attach ./camera-frame.jpg
/attach ./error.log
Explain what you see and propose the next debug step.
```

Images (`png`, `jpg`, `jpeg`, `gif`, `webp`) are sent as model image blocks when the active provider/model supports vision. Text files are inserted as prompt context. Use `/attach list` to review pending attachments and `/attach clear` to discard them. In a prompt, an `@path` reference (`summarize @README.md`) attaches that file inline.

## Use Your Own Model

The built-in D-Robotics gateway is for instant first use. Configure your own provider when you need your own account, billing, private gateway, data-local deployment, or a self-hosted model. Your model config always overrides the built-in gateway.

```bash
moss setup            # interactive: choose provider + model, paste the API key (hidden)
moss auth status      # show the resolved provider/model/key source
```

Supported providers are `deepseek`, `qwen`, `openai`, `anthropic`, and `openai-compatible`. A private OpenAI-compatible gateway:

```bash
moss config set provider openai-compatible
moss config set model <your-model>
moss config set baseUrl https://llm.example.com
moss setup            # stores the API key (hidden prompt)
moss
```

Model settings (provider, model, baseUrl, API key) live in moss config only. Environment variables such as `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `DMOSS_PROVIDER` are deliberately ignored — a key exported for another tool will never silently change which provider Moss talks to. `moss doctor` lists any such leftover variables under `env ignored`.

`baseUrl` is the API root, not the full chat endpoint — do not include `/chat/completions`. Both `https://llm.example.com` and `https://llm.example.com/v1` are accepted; Moss calls `/v1/chat/completions` for OpenAI-compatible providers, and rejects a malformed base URL at set time instead of failing on the first call.

Configuration priority is: CLI flags and `-c key=value` > project `.moss/config.json` > `moss config` / `moss setup` > built-in gateway. For scripts and CI, prefer an explicit config file over env vars: `moss --config-file /path/to/config.json` (JSON with `provider` / `model` / `baseUrl` / `apiKey`).

Inside Moss, use `/model` to list models from the active provider, choose by number, or type `/model <model-name>` for a custom model.

## Automation And Safety

For unattended benchmark or CI runs, choose an explicit approval policy before starting:

```bash
DMOSS_CLI_AUTO_APPROVE=1 moss --workspace-write "write and verify the tool"
# or persist a broader local policy:
moss config set profile autonomous
```

`DMOSS_CLI_AUTO_APPROVE=1` only approves tools that pass the active safety policy. It does not bypass `--read-only`, `deniedTools`, protected paths, the dangerous-command floor, or workspace sandbox checks. For browser-driven real websites, use `--full-access` because `web_browser_control` is classified as an external interaction. In a headless (`-p` / piped / non-TTY) run, auto-approved mutating tools leave a one-line `[approval]` audit note on stderr so the run stays observable.

Interactively you have three modes, toggled with **Shift+Tab**: `plan` (read-only — Moss proposes a plan but makes no changes), `default` (normal per-call approval), and `accept-edits` (auto-approve workspace writes). `/yolo` grants a full-power session with no per-call prompts for this run (`/yolo off` reverts). For unattended starts you can set the policy up front with `--ask-for-approval <policy>` where `<policy>` is `never`, `prompt`, `on-request`, `read-only`, `workspace-write`, or `full-access`; an unknown value is rejected rather than silently ignored. None of these bypass `--read-only`, `deniedTools`, protected paths, or the dangerous-command floor.

Trust can be scoped per tool with `moss config set trustedTools <csv>` and `deniedTools <csv>` (name or glob). A broad wildcard such as `*` is flagged when you set it, because it auto-approves every tool. Device mutations (reboot, restart, on-device `rm`, `ros2_service_call`, …) are never blanket-trusted: answering "always" approves only the current call, and the next device command still prompts.

Moss exposes two browser tools when a local Chrome/Chromium executable is available: `web_browser_fetch` for read-only JavaScript-rendered pages and `web_browser_control` for approved browser workflows. `@rdk-moss/agent` uses `puppeteer-core`, so it does not download a browser during install. If auto-discovery cannot find one, set `export DMOSS_BROWSER_EXECUTABLE="/path/to/chrome-or-chromium"`.

## MCP Servers

Moss can load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers. Register them without editing JSON:

```bash
moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data
moss mcp add ros-docs node ./mcp/ros-docs.js --env ROS_DISTRO=humble
moss mcp list
moss mcp remove fs
moss config set mcp.enabled true     # enable MCP servers from config
```

Inside a session, `/mcp` shows configured servers, their connection status, and tool counts. A server whose connection fails is reported rather than silently dropped. The server config lives next to your Moss config (default `~/.config/dmoss/mcp.json`); override the path with `moss config set mcp.configPath <path>` or `DMOSS_MCP_CONFIG`.

## Skills And Memory

Moss discovers `SKILL.md` files under `.moss/skills/`, `.moss/agent/skills/`, legacy `skills/` and `agent/skills/`, and configured extra skill directories. Built-in workflow skills cover methodical building, debugging, test-driven changes, migration safety, and CodeGraph navigation when available. Moss can install a new workspace skill itself through the `install_skill` tool, which writes a frontmatter-backed `SKILL.md` under `.moss/skills/<name>/SKILL.md` as a workspace write that goes through the normal approval policy. Successful runs can also crystallize into skill candidates you review with `/skills` and promote or discard.

Long-term memory is available through `memory_read` / `memory_write` / `memory_delete`, and Moss auto-loads workspace context from `USER.md`, `MEMORY.md`, and `AGENTS.md` at the workspace root. Use `/memory` to see stored memories.

## Honest Runtime Behavior

Moss tells the model what is actually available in the current run before it starts working:

- The system prompt includes the registered tool names for this run, so Moss should not invent tool names or claim unavailable capabilities.
- CodeGraph guidance is conditional: if `codegraph_*` tools are registered, Moss can prefer structural navigation; otherwise it says CodeGraph is unavailable and falls back to `search_code`, `search_files`, `list_directory`, and `read_file`.
- The behavior contract asks Moss to be 实事求是: separate verified facts from inference and assumptions, report missing evidence, and never claim a result — "connected", "launched", "opened", "done" — without an actual check behind it. Moss does not spawn a desktop GUI app to "open a terminal"; it already runs inside one.

## Troubleshooting

Run `moss doctor` to health-check Node, version, auth, provider/model, workspace, runtime dir, safety policy, and MCP in one report. It exits non-zero on a real failure, so it works as a CI health gate. Inside a session, `/doctor` runs the same check for the live run and `/mcp` shows MCP status. `moss config validate` checks config files and surfaces audit warnings.

## Build With Moss

Only using the CLI? You can stop here.

Building a product or service that embeds Moss? Scaffold a host project:

```bash
npx create-dmoss-app my-host
```

Embed into an existing product host by installing the packages, registering providers / tools / storage / approval gates / event sinks, publishing a `MossHostRuntimeManifest`, and running `evaluateMossHostCompatibility()` in CI. This is useful when you want Moss inside your own IDE, robot console, browser app, desktop app, or device platform instead of only as the `moss` terminal command — see [Integrating Moss Into A Host](#integrating-moss-into-a-host).

## Repository Scope

This repository contains the parts of Moss that can be maintained independently from a product shell.

| Package | Role |
| --- | --- |
| `@rdk-moss/core` | Public contracts, platform extension types, Host Adapter contract, and robotics prompts |
| `@rdk-moss/agent` | Agent runtime, tool loop, context management, safety helpers, skills, and provider adapters |
| `@rdk-moss/memory` | Context-aware memory selection and memory draft helpers |
| `@rdk-moss/skills` | Skill learning, validation, scoring, and promotion helpers |
| `@rdk-moss/teaching` | Teach-while-solve annotations and tool digest helpers |
| `create-dmoss-app` | Minimal project scaffolding for external Moss users |

Product hosts are outside this repository.

## Architecture

If you only use `moss`, you can skip this section. It exists for teams that embed Moss into a larger product.

Moss is split around a narrow host boundary:

```text
Product host
  - model keys and provider configuration
  - UI, native shell, persistence, telemetry
  - local workspace and device access
  - product tools and external channels
  - domain knowledge packages
        |
        | Host Adapter manifest + runtime injection
        v
Moss packages
  - agent loop and tool execution pipeline
  - context, memory, skills, and teaching primitives
  - host-neutral safety helpers
  - public extension contracts
```

The agent runtime should not import product code. Product hosts inject concrete providers, tools, storage, approval handling, knowledge modules, and event transports.

## Host Adapter Contract

The public contract lives in:

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';
```

A host declares its id/name/version, the Moss package versions it consumes, capabilities such as `llm_provider`, `tool_registry`, `approval_gate`, `event_sink`, `memory`, `knowledge`, `device_runtime`, and `channel_runtime`, the provider families it supplies, tool names and permission boundaries, and event schemas and knowledge modules. Moss releases use `evaluateMossHostCompatibility()` to decide whether a host can consume the release unchanged.

Read the detailed contract guide:

- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md)

## Project Goal And Roadmap

Moss is being developed as a robotics-grade, host-neutral agent runtime. The roadmap defines the north star, non-goals, six-month target, and phase plan:

- [`docs/roadmap.md`](docs/roadmap.md)

## Maintainer Guides

These documents are durable project manuals, not session notes:

- [`AGENTS.md`](AGENTS.md): agent working rules, architecture-review discipline, CodeGraph usage, and bug-fix checklists for this repository.
- [`ARCHITECTURE_ASSESSMENT.md`](ARCHITECTURE_ASSESSMENT.md): current architecture findings, rejected hypotheses, and "do not change" decisions.
- [`CLEAN_CODE_ASSESSMENT.md`](CLEAN_CODE_ASSESSMENT.md): code quality review and cleanup guidance.
- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md): Host Adapter contract guide.
- [`docs/tool-runtime.md`](docs/tool-runtime.md): tool execution pipeline, ownership boundaries, hooks, approval, timeout, and guard limits.
- [`docs/tool-side-effect-idempotency-rfc.md`](docs/tool-side-effect-idempotency-rfc.md): RFC for in-flight deduplication of non-idempotent tools.
- [`docs/release-checklist.md`](docs/release-checklist.md): release validation and host update checklist.

Historical phase notes such as [`docs/goals-phase-5.md`](docs/goals-phase-5.md) and [`docs/goals-phase-6.md`](docs/goals-phase-6.md) explain why the current contracts and tests exist, but the roadmap and release checklist are the source of truth for new work.

## Architecture Review Discipline

Do not turn open-ended reviews into endless issue lists. A candidate issue is worth fixing only when it blocks a committed goal, a real host path, safety, data correctness, resource lifecycle, or a contract that downstream users rely on. Style concerns, framework feature comparisons, and speculative future abstractions should be recorded as observations or rejected explicitly.

Before changing architecture, preserve this loop:

1. Generate hypotheses from the actual code and active host workflows.
2. Try to falsify each hypothesis by reading source, checking callers, tracing runtime flow, or running a focused test.
3. Fix bugs with declare + enforce + test. Existing tests are regression checks; the fix still needs a test that would have failed before the change.
4. Document "do not touch" conclusions when a suspicion is falsified, so future reviews do not re-litigate the same point.

## What Does Not Belong In Moss

Keep product-specific code in the host repository. Do not add:

- Product-host `server/**`, `src/**`, or native-shell code.
- Product configuration defaults, local sessions, logs, or generated desktop artifacts.
- Supabase keys, model keys, image provider keys, device passwords, SSH credentials, or user account details.
- Host-owned integrations such as board deployment, external chat channels, desktop IPC, native packaging, or product settings UI.
- Built `dist/` directories as tracked source.

RDK-specific domain knowledge may live in a separate optional package. The Moss core packages should stay useful to other robotics or device-product hosts.

## Development

Use Node 22.16 or newer for this workspace. Moss is verified on Ubuntu, macOS, and Windows in CI.

```sh
npm install
npm run verify
```

`npm run verify` runs open-source boundary checks, workspace hygiene checks (Node engine consistency, package test scripts, and local Markdown links), workspace builds, typechecks, and package tests. The boundary check can be run directly with `npm run check:boundaries`.

## Integrating Moss Into A Host

1. Install or vendor the relevant Moss packages.
2. Keep credentials and product-specific defaults in the host.
3. Register host providers, tools, storage, approval gates, and event sinks with the agent runtime.
4. Publish a `MossHostRuntimeManifest` from the host adapter.
5. Run `evaluateMossHostCompatibility()` in CI before adopting a new Moss release.

For a downstream product host, the host adapter lives in that host repository and should be validated by its own Moss upgrade flow.

## Version Policy

Moss follows semver for the public package surface.

- Patch releases fix bugs or improve internals without requiring host adapter changes.
- Minor releases may add optional fields, optional capabilities, or new helper APIs. Existing hosts should continue to work.
- Major releases may change required Host Adapter fields or required capabilities. Hosts must update their adapter before adopting the release.

For downstream product hosts, a Moss patch or minor update should normally be a submodule/package update plus validation. Adapter changes are required only when `MOSS_HOST_ADAPTER_CONTRACT_VERSION` changes incompatibly or a release declares new required host capabilities, event schemas, or provider families.

## Release Checklist

Every Moss release must pass the release checklist:

- [`docs/release-checklist.md`](docs/release-checklist.md)

At minimum, maintainers run:

```bash
npm run verify
npm run smoke:moss-cli
```

If the release is intended for a downstream host, update its Moss dependency or vendored subtree and run the host upgrade verification there.
