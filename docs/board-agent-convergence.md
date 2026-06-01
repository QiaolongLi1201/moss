# Moss OpenClaw Capability Coverage Goal

## Final Objective

Moss should become the agent runtime that makes users feel they can do the same
work through Moss that they can do through OpenClaw. OpenClaw remains useful as a
reusable board-side gateway/channel, but it should no longer be the separate
product mental model users depend on for "real work."

In the end state, Moss can coordinate desktop tools, board tools, files,
terminals, web/browser tools, attachments, channels, long-running tasks,
subagents, memory/skills, approvals, and external messaging with an experience
that is not weaker than OpenClaw. A product host may still route some actions through
OpenClaw internally, especially on-device actions, but the user-facing promise is
simple: use Moss; Moss can reach the right tool surface and execute the task.

## Evidence-Gated Current State

- OpenClaw positions itself as an any-OS gateway that connects many chat and
  channel surfaces to AI coding agents, with tool use, sessions, memory, and
  multi-agent routing.
- OpenClaw's docs include Control UI, WebChat, browser realtime talk, live tool
  output cards, logs, media uploads, channel delivery, session filtering, and
  multi-agent routing.
- A product host already gives Moss many local and product tools: workspace file
  read/write/edit/exec, web fetch/browser fetch, attachment read/image/audio
  analysis, host UI intents, terminal opening, device SSH/file/ROS/camera/VNC
  tools, external messaging tools, task tools, and OpenClaw board tools.
- A product host can expose `sessions_spawn` as a first-class subagent tool.
  A legacy host implementation starts a child run and returns immediately,
  then appends `subagent_summary` or `subagent_error` back into the parent
  session later.
- Upstream Moss has `create_subagent`, scoped tool profiles, recursion
  prevention, child workspace isolation for write-capable scopes, and in-memory
  child run collection, but it still does not define the full OpenClaw-like
  product capability surface as Moss-owned contracts.
- A product host classifies subagent and OpenClaw tool capabilities through the
  D-Moss capability manifest and permission boundaries.

## Capability Coverage Areas

Moss should cover OpenClaw at the level users feel, not only at the subagent
lifecycle level:

1. **Computer and workspace control**: local file read/write/edit, shell
   commands, patching, search, project context, generated artifacts, downloads,
   and safe previews.
2. **Board and robotics control**: device SSH, board file operations, ROS/TROS
   inspection and execution, camera/audio/VNC/desktop terminal tools, hardware
   diagnostics, deployment, and board-side verification.
3. **Browser and web work**: ordinary fetch, rendered browser fetch, web search,
   documentation lookup, authenticated-browser handoff where needed, and safe
   URL handling.
4. **Media and attachments**: image understanding, document/PDF/Office reading,
   audio/video transcription, file upload/download, and attachment routing
   between local, host UI, channels, and board.
5. **Channels and external actions**: chat channels, Feishu/Weixin/forum style
   sends, mobile or web surfaces, outbound media, and audit-friendly delivery
   state.
6. **Long-running task execution**: background tasks, subagents, task status,
   wait/yield, cancellation, retries, resumable summaries, and completion
   handoff.
7. **Memory, skills, and teaching**: reusable knowledge, validated skills,
   learned workflows, board-side skill install/write when appropriate, and clear
   provenance.
8. **Safety and governance**: tool allow/deny profiles, approval gates,
   side-effect classes, sandbox/tool policy, credential boundaries, audit
   events, and replay/idempotency protections.
9. **OpenClaw as channel/backplane**: OpenClaw should be mountable as one
   implementation for board-side execution, not the higher-level agent users
   need to reason about.

## Product Host Capability Matrix

The priority is based on board-development user jobs, not on copying every OpenClaw
feature. OpenClaw's tool list is useful evidence for what a broad agent gateway
can do, but a product host should first cover the jobs that make board development
feel complete through Moss.

### P0: Required For "Moss Is Not Worse Than OpenClaw"

| Capability | User-visible job | Current host coverage | Gap to close |
| --- | --- | --- | --- |
| Computer and workspace control | Inspect and edit project files, apply patches, run builds or scripts, and open a terminal without leaving Moss. | Core tool buckets already include `read`, `list`, `grep`, `write`, `edit`, `apply_patch`, and `exec`. | Host manifests must label these as Moss-owned surfaces with result presentation and approval metadata so routing does not depend on prompt wording. |
| Board and robotics control | Diagnose a selected board, run commands over SSH, read/write board files, inspect ROS/TROS, check cameras, flash readiness, VNC, and board terminal workflows. | Device buckets already include file, exec, ROS, camera, flash, VNC, TTS/STT, and board terminal tools. | Moss needs a board/robotics capability contract that can declare availability, side effects, progress, verification expectations, and fallback behavior. |
| OpenClaw backplane | Use OpenClaw for board-side gateway operations, pairing, skills, model switching, doctor checks, and fleet delegation while keeping Moss as the user-facing orchestrator. | Device and fleet buckets already include `board_openclaw_*`, `fleet_board_delegate`, and `fleet_board_broadcast`. | OpenClaw must be modeled as a channel/backplane with health, capabilities, structured errors, and task methods, not as a separate top-level agent tier. |
| Long-running work and subagents | Start slow research, build, flash, diagnosis, or fleet tasks without blocking the parent conversation; inspect status and receive a final summary once. | The host exposes `sessions_spawn` plus `dmoss_task_*`; OpenClaw has non-blocking spawn, status/log/steer, isolated/fork context, timeout, and completion handoff. | Moss needs async task/subagent handles, status, wait/yield, stop, timeout, parent-abort cascade, and idempotent completion records as host-neutral contracts. |
| Attachments and media understanding | Read uploaded PDFs, Office files, logs, images, and audio/video transcripts; move attachments between user chat, local workspace, and board paths. | The host registers `attachment_list`, `attachment_read`, `attachment_describe_image`, and `attachment_get_audio_transcript`; device upload can consume attachment ids. | Moss needs a declared attachment/media surface and routing policy for inbound channel media, local files, board uploads/downloads, and result rendering. |
| Web and documentation work | Search/fetch RDK docs, forums, SkillHub, web pages, downloads, and forum posts as part of board troubleshooting. | Web/forum buckets include search, local RDK doc search, fetch, rendered browser fetch, extract, download, forum auth/status, and posting tools. | Moss should route web work by capability and network policy, and distinguish simple fetch from real browser automation. |

### P1: Important Coverage After P0 Contracts Exist

| Capability | User-visible job | Current host coverage | Gap to close |
| --- | --- | --- | --- |
| Real browser automation | Navigate authenticated pages, click through dashboards, capture screenshots, download/upload files, inspect console/errors, and debug web UIs. | The host has URL open, embedded browser capture, local preview, and rendered web fetch. | OpenClaw's browser surface is deeper: navigation, click/type, screenshots, downloads/uploads, cookies/storage, console, errors, device emulation. Product hosts should add this only when a real workflow needs it. |
| Channels and external delivery | Send useful results or alerts through Feishu/Weixin/forum-style surfaces and preserve delivery state. | The host has outbound messaging tools and forum posting tools. | Inbound media, per-channel progress streaming, retry/delivery state, and broad channel parity are not yet Moss contracts. |
| Memory, skills, and teaching | Persist user preferences, board facts, validated procedures, and reusable workflows. | Core memory tools, host memory tools, skill discovery, and board OpenClaw skill install/write tools exist. | Moss needs provenance and validation rules that connect memory, skills, board-side skills, and host knowledge without blurring them. |
| Media and voice assistance | Understand camera frames or screenshots, transcribe audio/video, and optionally speak or listen in board workflows. | Attachment image/audio tools and board TTS/STT tools exist. | Image/video/music generation is not a P0 board-development need; media understanding for board debugging is the higher-value slice. |

### P2: Defer Until A Concrete Host Workflow Needs It

| Capability | Why deferred |
| --- | --- |
| Image/video/music generation | OpenClaw supports generation tools, but they are not core to RDK board development unless a product workflow asks for demo media creation. |
| Cron/gateway management | Scheduled board health checks are plausible, but async task contracts and task status should come first. |
| Canvas/nodes parity | OpenClaw has canvas/nodes concepts; product hosts should not copy them unless visual workflow work creates a concrete need. |

### Do Not Change Yet

- Do not remove existing host tools simply because they are not part of a
  P0 surface. P1/P2 tools can remain available while Moss learns to classify
  them.
- Do not add browser, media generation, cron, or canvas abstractions merely for
  parity. Each new abstraction needs a real host workflow and verification
  path.
- Do not make Moss import a product host's OpenClaw manager. The backplane must be
  exposed by a host/channel contract.

## Acceptance Criteria

1. Users can ask Moss to perform representative OpenClaw-style work without
   being redirected to a separate OpenClaw mental model: inspect a machine,
   operate files, run commands, use a browser/web source, process attachments,
   call board tools, and report verified results.
2. Moss has a runtime capability manifest that can declare, project, and inspect
   the actual tool surfaces available in a host: desktop/local, board/device,
   browser/web, attachment/media, messaging/channel, task/subagent, memory/skill,
   and OpenClaw channel. Hosts must also expose the effective per-session tool
   inventory so configured-but-unavailable tools have structured reasons instead
   of disappearing silently.
3. Moss can route tasks by capability, not by product name. When the same action
   can be done locally, on the board, or through OpenClaw, Moss chooses based on
   availability, safety, expected quality, and fallback behavior.
4. Moss exposes host-neutral contracts for tool execution, progress, result
   presentation, approvals, side-effect class, retry/fallback, and cancellation.
5. Moss exposes async task/subagent contracts for start, status, wait/yield,
   stop, timeout, parent abort cascade, and idempotent completion handoff.
6. Moss supports child/task options that matter for OpenClaw-like work:
   cwd/workspace, model, reasoning/thinking, run timeout, sandbox/tool policy,
   context payload, channel preference, and cleanup policy.
7. Moss-owned tool profiles cover allow/deny behavior for task scopes,
   including read-only, device-read, explore, plan, verify, and full.
8. Moss can mount OpenClaw as a board channel with declared capabilities,
   health/status, task execution methods, and structured errors; Moss must not
   import a product host's OpenClaw manager directly.
9. Product hosts invoke user-facing board-side agent work through Moss-owned
   contracts. Direct OpenClaw tools can remain internally, but prompts and
   capability manifests should present Moss as the orchestrator.
10. Migration preserves useful existing host behavior, including non-blocking
    `sessions_spawn`, live progress, approval boundaries, and device mutation
    safeguards.
11. Tests cover at least: local task success, board-channel success, missing
    capability, permission denial, timeout, cancellation, parent abort,
    duplicate completion replay, fallback routing, and result presentation
    metadata.
12. A representative parity smoke suite proves Moss can complete a useful
    OpenClaw-like workflow end to end: inspect context, use tools, perform an
    action, verify the result, and produce a concise user-facing answer.

## Milestones

### 1. Capability Contract And Inventory

Define the Moss-owned capability model and map what a product host already exposes.
This prevents the project from treating "OpenClaw parity" as a vague checklist.

Deliverables:

- Capability taxonomy for local computer, board/device, browser/web,
  attachment/media, channel/messaging, task/subagent, memory/skill, and
  OpenClaw-channel tools.
- Host manifest contract that can declare tool availability, side-effect class,
  approval policy, result presentation, progress support, and fallback options.
- A host inventory document or generated report that maps existing D-Moss
  tools into the taxonomy.
- Tests for manifest validation and missing-capability diagnostics.

### 2. Task Execution And Routing

Make Moss choose and govern the right tool surface for a task, instead of
hard-coding product-specific routes in prompts.

Deliverables:

- Capability-aware task router for local vs board vs OpenClaw-channel execution.
- Result/progress envelope shared by desktop, board, browser, and channel tools.
- Fallback behavior when a preferred capability is unavailable, denied, or fails.
- Representative smoke tests for local+board+web+attachment workflows.

### 3. Async Work And Subagents

Preserve OpenClaw-like background execution while making lifecycle governance a
Moss contract.

Deliverables:

- Stable async task/subagent handle.
- `spawn`, `status`, `wait/yield`, and `stop` semantics.
- Idempotent completion records.
- Parent abort cascade and concurrency/depth limits.
- Host adapter that maps current `sessions_spawn` behavior into the Moss
  contract.

### 4. OpenClaw Channelization

Reduce OpenClaw to one implementation behind Moss, while keeping its strengths
available.

Deliverables:

- Board channel interface with capability declaration and health/status.
- OpenClaw implementation of the channel interface.
- Test/stub channel for CI and local development.
- Host prompts and capability manifests speak in Moss terms first, with
  OpenClaw named only as an implementation where useful for diagnostics.

## Current Tool-Layer Implementation

The first safe slice started with capability coverage, not only subagent state.
Moss now has a Moss-owned tool-surface taxonomy, static runtime projection, and
effective per-session tool inventory. This borrows the strongest OpenClaw tool
layer idea: distinguish the catalog a host declares from the tools that are
actually usable right now, with reasons for policy, profile, runtime, and
readiness filtering.

Implemented slice:

1. Extend `moss/packages/dmoss/src/contracts/host-adapter.ts` with stable tool
   surface/result-surface constants and optional fields on host tool
   declarations.
2. Add compatibility validation for missing required tool surfaces and invalid
   surface/result-surface values while preserving legacy manifests that omit
   the optional fields.
3. Add conformance coverage for all P0/P1 surface constants, missing-surface
   diagnostics, invalid-surface rejection, and legacy compatibility.
4. Add `projectMossHostRuntimeCapabilities()` so compatibility checks and host
   diagnostics read the same projected capability sets instead of rebuilding
   hidden local sets.
5. Add `buildMossHostEffectiveToolInventory()` so product hosts can expose a
   session-scoped "available right now" view with notices for disabled,
   policy-denied, profile-hidden, and readiness-blocked tools.
6. Add async task/subagent handles as the first lifecycle primitive under the
   same capability model.

Current local progress:

- Moss now declares and validates the tool-surface/result-surface taxonomy in
  the host-adapter contract, with conformance tests for invalid values,
  missing required surfaces, and legacy manifests that omit optional fields.
- Moss now exposes a runtime capability projection helper and uses it from the
  compatibility evaluator. This makes the tool-layer declarations observable by
  code, not only by documentation.
- Moss now exposes an effective tool inventory helper for the OpenClaw-inspired
  "catalog vs available right now" split. It keeps OpenClaw-specific execution
  out of core Moss while letting Studio explain why board, browser, attachment,
  task, or OpenClaw-channel tools are not currently usable.
- A product host now maps its declared D-Moss tool buckets into those surfaces in
  the host adapter implementation and verifies that the P0
  surface inventory is present.
- Until a product host updates its consumed Moss code to a commit containing the new
  contract fields, the host keeps a compatibility-period surface check in its
  own host-adapter evaluator so `requiredToolSurfaces` cannot be silently
  ignored by the older Moss evaluator.
- Moss core now also includes a host-neutral async task/subagent lifecycle
  contract with an in-memory reference registry. The registry returns stable
  handles immediately, records idempotent completions, supports wait/status/list
  operations, propagates parent aborts, cancels child task trees, and enforces
  timeout completions. This is not wired to product-host or OpenClaw code yet; it is the
  runtime contract the next adapter slice can consume.
- `@rdk-moss/agent` now consumes that contract for an opt-in
  `create_subagent` background path. The default tool behavior still waits for
  the child and returns the final summary, while `background: true` starts the
  same child through the async task registry and returns a stable task handle
  immediately. This proves the contract is no longer only a declaration; the
  existing subagent tool can execute through it without changing the default
  synchronous user path.
- The background path now has matching `subagent_status` and `subagent_stop`
  tools. They can inspect a non-blocking status snapshot, wait for final
  completion, or cancel a no-longer-useful child run, giving Moss the first
  start/status/wait/control loop needed for OpenClaw-like long-running work.
- The CLI TUI `!cmd` path is deliberately a local `computer_shell` surface. It
  is useful for host-side diagnostics and repair loops, but it is not evidence
  that `openclaw_channel` is connected. OpenClaw channel/backplane availability
  must come from declared channel tools and effective inventory readiness such
  as `openclaw_gateway_ready`.

## Things Not To Change Yet

- Do not remove a product host's current `sessions_spawn`; it already provides
  useful non-blocking behavior that must be preserved.
- Do not make Moss import a product host's OpenClaw manager directly. OpenClaw access
  should enter Moss through a host/channel interface.
- Do not collapse tool permission boundaries into prompt text. Runtime policy
  must continue to enforce declared tool capability and side-effect metadata.
- Do not frame parity as "copy OpenClaw internals." The target is user-visible
  capability coverage: Moss can perform the same classes of work with equal or
  better governance.
