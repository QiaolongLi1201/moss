# Standalone Moss & RDK Studio Adapter Convergence

Moss should be a capable agent **on its own** — run `moss` in any project
directory and get the same "sees your whole project, your terminal, your git
state" experience that RDK Studio provides when it embeds Moss — not only a
library that RDK Studio drives. This note records what standalone Moss now has,
and which generic capabilities still live in the RDK Studio adapter and could
move down into Moss core over time.

Guiding rule: **additive, non-breaking convergence.** When a generic capability
moves into Moss core, standalone Moss gains it immediately; RDK Studio keeps its
richer version and can later simplify to consume Moss's. We do not rip
capabilities out of the host before Moss can stand in for them.

## What a standalone `moss` run can access

Running `moss` in a directory, the agent works with:

| Capability | Status | Where |
|---|---|---|
| **Your project** — read/search/edit files in the workspace sandbox | ✅ | `read_file` (+paging), `write_file`, `move_file`, `apply_patch`, `search_files`, `search_code`, `list_directory` |
| **Your terminal** — run any command; start/inspect/stop servers | ✅ | `exec`, `exec_background` / `exec_logs` / `exec_stop` |
| **The web** — search + fetch | ✅ | `web_search`, `web_fetch` |
| **Type/lint diagnostics** after edits | ✅ | `code_diagnostics` |
| **Your git state** — branch, uncommitted changes, recent commits | ✅ (new) | `context/environment.ts` injected at session start |
| **Your MOSS.md** — per-project instructions/conventions | ✅ (new) | `WorkspaceMemory` (`MOSS.md` / `Moss.md`, plus `AGENTS.md`) |
| **Auto memory** — `MEMORY.md` + indexed recall | ✅ | `WorkspaceMemory` (MEMORY.md/USER.md) + `MemoryManager` (`memory_read/write/delete`) |
| **Skills** — extend what the agent knows | ✅ | `SkillRegistry` scans `<workspace>/skills/`, `<workspace>/agent/skills/` |
| **MCP** — connect external services | ✅ | `mcp.json` → `connectMcpServers` (wired in the CLI) |
| **Hooks** — automate workflows | ✅ (new) | config `hooks` → `cli/hooks.ts` (PreToolUse / PostToolUse / SessionStart) |
| **Subagents** — offload tasks | ✅ | `create_subagent` + `spawnSubagent` (scoped tool sets) |

The rows marked "new" are the gaps closed in this change. Everything else was
already standalone-capable.

## Adapter layer: GENERIC vs STUDIO

Audit of `rdstudio-web/server` for what the host adds on top of Moss core:

### GENERIC — candidates to live in Moss core

| Capability | Current location (rdstudio-web) | Convergence status |
|---|---|---|
| Git context injection | `server/dmoss/run/turn-diff.ts` | **Moved (additive):** Moss core now has `context/environment.ts`. Studio keeps per-turn diffs; Moss does a session-start snapshot. |
| Project-instruction markdown load | `server/dmoss/knowledge/workspace-store.ts` | **Partly moved:** Moss `WorkspaceMemory` loads `MOSS.md`/`AGENTS.md`/`USER.md`/`MEMORY.md`. Studio adds bundled persona templates. |
| Config-driven hooks | (none — new capability) | **Added to Moss core** (`cli/hooks.ts`). |
| Memory wiring (daily + long-term) | `server/dmoss/prompt/system-prompt-layers.ts`, `MemoryManager` | Already in Moss (`MemoryManager` + `WorkspaceMemory`); Studio adds daily-journal selection. Candidate to lift daily-memory selection into Moss. |
| Persona/style injection | `server/dmoss/prompt/persona-store.ts` | Future: a generic persona layer in Moss; Studio keeps its product persona. |
| Prefix-cache prompt layering (stable/dynamic split) | `server/dmoss/prompt/system-prompt-layers.ts` | Future: Moss already has `extraPromptLayers`; a stable/dynamic split would improve cache hit rate for all hosts. |
| Generic tool-contract scaffold | `server/adapters/default-tool-contract-prompt.ts` | Future: the platform-neutral discipline (file safety, git, parallelism) is generic; the RDK/Drobotics variants stay in Studio. |
| Vendor plugin registry | `server/adapters/index.ts` | Contract already in `@dmoss/core`; registry pattern could move down. |

### STUDIO — stays in rdstudio-web

Device SSH/`device_*` tools, OpenClaw board deployment, RDK knowledge modules,
Drobotics product prompts, forum/community channels, board diagnostics &
flashing, Electron/desktop UX tools, Studio session/approval UI, board
capability snapshots, web-cloud deployment guards. These are board/Studio
specific and should not move into Moss.

## Roadmap (priority order)

1. **Done now (additive):** git/env context, `MOSS.md`, config-driven hooks.
2. **Next, low-risk:** lift daily-memory (`memory/YYYY-MM-DD.md`) selection into
   Moss `WorkspaceMemory`; expose a generic persona layer.
3. **Then:** stable/dynamic system-prompt split in Moss core for prompt-cache
   friendliness across hosts; move the neutral tool-contract scaffold down.
4. **Coordinated:** once Moss core covers a capability, simplify the
   corresponding rdstudio-web adapter code to consume Moss's version (separate,
   reviewed change per the upstream-update flow — push Moss, bump the
   `external/moss` submodule, then thin the adapter).
