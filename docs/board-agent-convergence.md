# Moss Board-Agent Convergence Goal

## Final Objective

Moss should become RDK Studio's single upper-level agent runtime for both desktop
and board-side work. OpenClaw remains valuable, but its long-term product role is
as a reusable board-side implementation/channel behind Moss, not as a permanent
parallel agent tier that users or host prompts must reason about separately.

In the end state, any capability that OpenClaw can perform on the board should be
reachable through Moss-owned contracts for subagent lifecycle, tool permissions,
completion handoff, observability, and host adaptation. RDK Studio can still use
OpenClaw as the board backplane, but the product mental model is: the user works
with Moss; Moss chooses and governs the board channel.

## Evidence-Gated Current State

- RDK Studio already exposes `sessions_spawn` as a first-class subagent tool.
  The legacy Studio implementation starts a child run and returns immediately,
  then appends `subagent_summary` or `subagent_error` back into the parent
  session later.
- Studio prompts already tell the agent that `sessions_spawn` is a non-blocking
  background child task.
- Upstream Moss has `create_subagent`, but the tool currently awaits
  `ctx.spawnSubagent()` and returns the child summary synchronously.
- Moss has useful primitives that should be preserved: scoped tool profiles,
  recursion prevention, child workspace isolation for write-capable scopes, and
  in-memory child run collection.
- Studio already classifies subagent and OpenClaw tool capabilities through the
  D-Moss capability manifest and permission boundaries.

## Acceptance Criteria

1. Moss exposes a host-neutral async subagent contract that can start a child
   task and immediately return a stable handle without blocking the parent run.
2. Moss exposes a wait/yield operation, or equivalent host adapter method, that
   waits for a specific child handle to complete and returns the final summary.
3. Moss maintains observable child state: queued, running, completed, failed,
   cancelled, timed out, plus timestamps and parent/child linkage.
4. Child completion handoff is idempotent. Re-reading or replaying completion
   must not append duplicate parent summaries or repeat side effects.
5. Moss supports retry/fallback routing at the contract layer: a failed board
   channel can return a structured failure that lets the parent choose local,
   board, or alternate-channel recovery.
6. Moss-owned tool profiles cover allow/deny behavior for child scopes,
   including read-only, device-read, explore, plan, verify, and full.
7. Child task options cover the board-agent surface that matters in practice:
   cwd/workspace, model, reasoning/thinking, run timeout, sandbox/tool policy,
   context payload, cleanup policy, and optional channel preference.
8. Moss enforces concurrency and depth limits for children, and provides
   cascade stop semantics when a parent run is aborted or cleaned up.
9. RDK Studio invokes board-side agent work through Moss-owned contracts. Direct
   OpenClaw tools can remain internally, but user-facing prompts and capability
   manifests should not require OpenClaw as a separate agent tier.
10. OpenClaw can be mounted as a Moss board channel with declared capabilities,
    health/status, spawn/wait/stop/status methods, and structured errors.
11. The migration preserves existing Studio behavior: `sessions_spawn` remains
    non-blocking for current users while newer Moss paths can use explicit
    handles and wait/status APIs.
12. Tests cover success, failure, timeout, cancellation, parent abort, duplicate
    completion replay, permission denial, depth limit, concurrency limit, and
    OpenClaw-channel fallback behavior.

## Milestones

### 1. Contract-First Bridge

Define the Moss async child-task contract without changing board runtime behavior
yet. The first implementation can wrap the current Studio/OpenClaw path, but the
contract must be Moss-owned and testable without a real board.

Deliverables:

- `AsyncSubagentHandle` or equivalent stable handle type.
- `spawn`, `wait/yield`, `status`, and `stop` semantics in a host-neutral
  interface.
- Idempotent completion records with tests before any UI or prompt expansion.
- A Studio adapter that can map the current non-blocking `sessions_spawn`
  behavior into the new contract.

### 2. Moss-Native Lifecycle Governance

Move lifecycle rules into Moss so Studio/OpenClaw is no longer the only place
that understands child state, retries, cancellation, and limits.

Deliverables:

- Child registry keyed by stable run id.
- Parent abort and cleanup cascade.
- Concurrency/depth enforcement in Moss.
- Tool-profile enforcement remains Moss-owned, with host extensions only adding
  product-specific tools.
- Event stream coverage for child queued/running/completed/failed/cancelled.

### 3. OpenClaw Channelization

Reduce OpenClaw to a board channel implementation behind Moss contracts.

Deliverables:

- Board channel interface with capability declaration and health/status.
- OpenClaw implementation of the channel interface.
- Test/stub channel for CI and local development.
- Studio prompts and capability manifests speak in Moss terms first, with
  OpenClaw only named as an implementation where necessary for diagnostics.

## Smallest Safe Next Implementation

The next code change should not try to "replace OpenClaw." The smallest safe
step is to add a Moss-owned async subagent contract and tests that prove
idempotent handle semantics without requiring a real board. After that passes,
RDK Studio can adapt its existing `sessions_spawn` path to the contract.

Suggested first slice:

1. Add a contract module under `moss/packages/dmoss-agent/src/core/subagent/`
   for async child handles and states.
2. Add a pure in-memory registry with `spawned`, `completed`, `failed`,
   `cancelled`, and idempotent `readCompletion` transitions.
3. Add `node:test` coverage for duplicate completion replay and parent abort.
4. Only then wire the registry into `createSubAgentRunner` or a new host
   adapter bridge.

## Things Not To Change Yet

- Do not remove RDK Studio's current `sessions_spawn`; it already provides the
  non-blocking user-visible behavior that must be preserved.
- Do not make Moss import Studio's OpenClaw manager directly. OpenClaw access
  should enter Moss through a host/channel interface.
- Do not collapse tool permission boundaries into prompt text. Runtime policy
  must continue to enforce the declared tool profile.
- Do not turn this into a generic framework checklist. Each capability should
  remain tied to a real board-side user path or a verified lifecycle bug.
