# Moss

**English** · [简体中文](README.zh-CN.md)

**A robotics-aware terminal agent that runs out of the box — and an embeddable agent runtime you can build on.** Made by 地瓜机器人 (D-Robotics).

Run `moss`, ask a question, get to work. No API key, no forced login — the first launch already talks to the built-in D-Robotics gateway. When you want your own model, billing, or private endpoint, point Moss at any OpenAI-compatible or Anthropic provider without changing the agent. `/connect` an RDK board and the whole session moves onto the device over SSH.

> `moss` is the primary command; `dmoss` stays as a compatible alias.

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-tui-demo.gif" alt="Moss terminal startup demo" width="720" />
</p>

## Quick Start

```bash
npm i -g @rdk-moss/agent@latest   # Node 22.16+
moss
```

The first launch works immediately on the built-in gateway — ask it something and it answers. No key, no login required.

```bash
moss "check disk usage on this project"   # one-shot: answer and exit
echo "list the failing tests" | moss      # piped stdin
moss -m qwen-plus "summarize @README.md"  # override the model; @path attaches a file
```

Update with `npm i -g @rdk-moss/agent@latest`, or `/upgrade` from inside Moss.

## Why Moss

The familiar Claude Code / Codex terminal loop, with a different ownership model:

- **Zero-setup start** — built-in D-Robotics gateway, no model key, no forced login.
- **Bring your own model** — DeepSeek, Qwen, OpenAI-compatible, Anthropic, or self-hosted. Switching providers never changes the agent.
- **Robot- and board-native** — `/connect <ip>` runs the session on an RDK board over SSH with diagnostics and ROS2 tools; teach it the whole RDK stack with [device-knowledge](#give-moss-rdk-board-skills) skills.
- **Survives long, interruptible work** — sessions auto-save, a working-context checkpoint tracks the active task, and `moss resume` picks it back up instead of restarting.
- **Honest by design** — separates verified facts from inference, reports when a capability is unavailable, and never claims a result it did not check.
- **Embeddable** — a runtime with public contracts and npm packages, not only a standalone app.

## Everyday Use

Start Moss in a project, then drive it in plain language. Type `/help` for the full command list; the ones you will use most:

| Command | Purpose |
| --- | --- |
| `/status` · `/model` | Show model/login/workspace/board state · switch the active model |
| `/connect <ip>` · `/disconnect` | Enter / leave board mode for an RDK device |
| `/resume [key\|--last]` · `/sessions` | Switch into a saved conversation · list them |
| `/goal <condition>` | Run until a goal condition is met (goal runner) |
| `/attach <path>` · `/diff` · `/review` | Attach an image/file · show changes · review them for bugs |
| `/skills` · `/memory` · `/mcp` · `/doctor` | Inspect skills · memory · MCP servers · health-check the run |
| `/compact` · `/clear` · `/yolo` | Compress history · new conversation · full-power session (`/yolo off` reverts) |

Press **Shift+Tab** to cycle interaction modes: `plan` (read-only), `default` (per-call approval), `accept-edits` (auto-approve workspace writes). Attach context inline with an `@path` reference (`summarize @README.md`) or `/attach ./screenshot.png`; images go to vision-capable models, text files become prompt context.

## Connect An RDK Board

`/connect` inside a live session — no restart needed:

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-connect-vision.gif" alt="Moss board connection and image attachment demo" width="720" />
</p>

```text
/connect 192.168.1.10 --user root
/connect ubuntu@192.168.1.10 --port 2222 --key ~/.ssh/id_rsa
Check camera, ROS2 nodes, disk space, and device health.
```

`/connect` verifies SSH reachability and credentials before enabling device tools; if the probe fails it reports why and the tools stay disabled (`--no-verify` skips the probe). After a verified connect the session enters **board mode**: the default tools (`exec`, `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, …) run on the board over SSH, and ROS2 (`ros2_topic_list`, `ros2_node_list`, `ros2_service_call`, `ros2_launch`, …) plus `device_*` diagnostics become available, honoring the board's `ROS_DOMAIN_ID`. Leave with `/disconnect` (or Ctrl+D on an empty prompt) to restore local tools exactly as they were; `--hybrid` keeps local tools and only adds the `device_*` / `ros2_*` ones. The host keeps control of SSH credentials, approval policy, and protected paths.

### Give Moss RDK Board Skills

On (or connected to) an RDK board, Moss is most useful when it knows the RDK stack. The open [**device-knowledge**](https://github.com/D-Robotics/device-knowledge) pack is a set of `SKILL.md` files Moss loads directly — point it at the pack and Moss applies that knowledge while operating the board:

| Skill | What it unlocks |
| --- | --- |
| `rdk-device` | Model-deploy loop (`.pt`/`.onnx` → `.bin` BPU toolchain), first-boot networking, camera / vision inference |
| `rdk-ros` | TROS/ROS2 setup, `ros2` commands, node troubleshooting, stereo-depth / Livox nodes |
| `rdk-peripheral-cookbook` | GPIO / I2C / SPI / UART, PWM servos, motors, LED / WS2812, audio (ALSA), `libgpiod` |
| `rdk-board-knowledge` | Board-baseline checks, error diagnosis, a 55-entry fault lookup |
| `rdk-hardware` · `rdk-ecosystem` | 40-pin GPIO, camera, BPU pipeline, thermal, networking · RDK lineup, model feasibility, cross-platform compare |
| `jetson-knowledge` · `rpi-knowledge` · `rk-knowledge` | Equivalent packs for Jetson, Raspberry Pi, and Rockchip RK3588 |

Load the pack any one of these ways, then run `/skills` to confirm:

```bash
# 1. Clone into a default skill root (auto-scanned, no config):
git clone https://github.com/D-Robotics/device-knowledge ~/.agents/skills/device-knowledge

# 2. Or point your Moss config at the pack's skills/ directory:
#    add to your moss config.json →  "skills": { "extraRoots": ["/path/to/device-knowledge/skills"] }

# 3. Or just run Moss from inside a checkout — its skills/ folder is auto-discovered.
```

The skills are knowledge and instructions, not board binaries: they make Moss act correctly on the device, while the host still owns credentials and approvals.

## Long-Running Tasks And Resume

Every plain `moss` launch is a new saved conversation; you pick history back up only when you ask:

```bash
moss resume --last            # continue the most recent session
moss --session work           # continue or create a named session
moss --continue "keep going"  # one-shot that auto-resumes the latest session
moss fork --last              # branch a copy without touching the original
```

Within a run, Moss keeps a working-context checkpoint of the active task (goal, done/pending steps, key paths, recent findings). If a run is interrupted — a tool-loop guard fires, a tool errors, or the turn budget is reached — the task is marked **resumable** instead of lost: the CLI tells you it stopped early and how to continue, and saying `continue` / `继续` (or `/goal`) resumes from the checkpoint instead of repeating finished steps. Compaction preserves the goal and pending steps, so long tasks keep their thread.

```text
/goal migrate this repo to the new package name and verify the build
```

The goal runner keeps working until the goal is completed, blocked, cleared, or stopped.

## Use Your Own Model

The built-in gateway is for instant first use; configure your own provider when you need your own account, billing, private gateway, or a self-hosted model. Your config always overrides the gateway.

```bash
moss setup            # interactive: choose provider + model, paste the key (hidden)
moss auth status      # show the resolved provider/model/key source
```

Supported providers: `deepseek`, `qwen`, `openai`, `anthropic`, `openai-compatible`. For a private gateway:

```bash
moss config set provider openai-compatible
moss config set model <your-model>
moss config set baseUrl https://llm.example.com   # API root, not /chat/completions
moss setup                                         # stores the key (hidden prompt)
```

Model settings live in moss config only — environment variables like `OPENAI_API_KEY` or `DMOSS_PROVIDER` are deliberately ignored so a key exported for another tool never silently changes your provider (`moss doctor` lists any such leftovers). Priority: CLI flags / `-c key=value` > project `.moss/config.json` > `moss config` / `moss setup` > built-in gateway. Inside Moss, `/model` lists provider models or sets a custom one.

## Automation And Safety

Moss asks before file writes, commands, and external actions unless you choose a more autonomous policy. Interactively, **Shift+Tab** cycles `plan` / `default` / `accept-edits`, and `/yolo` grants a full-power session (`/yolo off` reverts). For unattended starts, set the policy up front:

```bash
moss --ask-for-approval workspace-write "write and verify the tool"
DMOSS_CLI_AUTO_APPROVE=1 moss -p "run the benchmark"
```

`--ask-for-approval` accepts `never`, `prompt`, `on-request`, `read-only`, `workspace-write`, and `full-access`; an unknown value is rejected, not ignored. None of these — nor `DMOSS_CLI_AUTO_APPROVE=1` — bypass `--read-only`, `deniedTools`, protected paths, or the dangerous-command floor. Device mutations (reboot, on-device `rm`, `ros2_service_call`, …) are never blanket-trusted: "always" approves only the current call. Scope trust per tool with `moss config set trustedTools/deniedTools <csv>`. In a headless run, auto-approved mutating tools leave a one-line `[approval]` audit note on stderr.

Run `moss doctor` to health-check Node, version, auth, provider/model, workspace, safety policy, and MCP in one report; it exits non-zero on a real failure, so it works as a CI gate.

## Skills, Memory & MCP

Moss discovers `SKILL.md` files under `.moss/skills/`, `~/.agents/skills`, and configured `skills.extraRoots` (see [board skills](#give-moss-rdk-board-skills)). Built-in workflow skills cover methodical building, debugging, test-driven changes, and migration safety; the `install_skill` tool can author a new workspace skill through the normal approval policy, and good runs crystallize into candidates you review with `/skills`. Long-term memory works through `memory_read`/`memory_write`/`memory_delete`, and Moss auto-loads `USER.md`, `MEMORY.md`, and `AGENTS.md` from the workspace root (`/memory` to inspect).

Load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers without editing JSON:

```bash
moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data
moss mcp list
moss config set mcp.enabled true
```

`/mcp` shows configured servers, connection status, and tool counts; a server that fails to connect is reported, not silently dropped.

## Embed Moss In Your Product

Only using the CLI? You can stop here. Building a product that embeds Moss? Scaffold a host:

```bash
npx create-dmoss-app my-host
```

Moss is split around a narrow host boundary: the host owns model keys, UI, storage, telemetry, device access, product tools, and knowledge packages; Moss owns the agent loop, tool pipeline, context/memory/skills primitives, and host-neutral safety. A host registers its providers/tools/storage/approval gates/event sinks, publishes a `MossHostRuntimeManifest`, and runs `evaluateMossHostCompatibility()` in CI before adopting a release.

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';
```

| Package | Role |
| --- | --- |
| `@rdk-moss/core` | Public contracts, platform extension types, Host Adapter contract, robotics prompts |
| `@rdk-moss/agent` | Agent runtime, tool loop, context management, safety, skills, provider adapters |
| `@rdk-moss/memory` · `@rdk-moss/skills` · `@rdk-moss/teaching` | Memory selection · skill learning · teach-while-solve annotations |
| `create-dmoss-app` | Minimal project scaffolding for external hosts |

See the [Host Adapter contract guide](docs/host-adapter-contract.md) for the full surface and version policy.

## For Maintainers & Contributors

```bash
npm install
npm run verify   # OSS-boundary + hygiene checks, build, typecheck, lint, tests (Ubuntu/macOS/Windows in CI)
```

Durable project manuals (not session notes):

- [`AGENTS.md`](AGENTS.md) — agent working rules, architecture-review discipline, CodeGraph usage, bug-fix checklists.
- [`docs/roadmap.md`](docs/roadmap.md) — north star, non-goals, and phase plan.
- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md) — Host Adapter contract guide and version policy.
- [`docs/tool-runtime.md`](docs/tool-runtime.md) — tool execution pipeline, approval, timeout, and guard limits.
- [`docs/release-checklist.md`](docs/release-checklist.md) — release validation and host-update checklist.
- [`ARCHITECTURE_ASSESSMENT.md`](ARCHITECTURE_ASSESSMENT.md) — architecture findings, rejected hypotheses, and "do not change" decisions.

Keep product-specific code (native shells, product config/secrets, board deployment, packaging) in host repositories — the Moss core packages stay useful to any robotics or device-product host. Moss follows semver for its public package surface; a patch/minor update should be a dependency bump plus validation, and adapter changes are required only when `MOSS_HOST_ADAPTER_CONTRACT_VERSION` changes incompatibly.
