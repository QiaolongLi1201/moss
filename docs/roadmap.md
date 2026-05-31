# Moss Roadmap

## North Star

Moss is a robotics-grade, host-neutral agent runtime for robotics and edge
device products. Product hosts bring their own UI, model providers, tools,
storage, approval policy, knowledge, memory, telemetry, and deployment choices.
Moss provides the stable runtime core that lets those hosts upgrade agent
capability without rewriting the product shell.

The project should be powerful because its runtime is reliable, auditable, and
easy to embed, not because it tries to own every layer of the product stack.

## Focus

Moss should concentrate on the surfaces that are hard to rebuild correctly in
every robotics product:

- A stable Host Adapter contract for injecting model providers, tools, session
  storage, approval gates, event sinks, knowledge modules, memory, and device
  capabilities.
- A reliable agent loop for streaming turns, tool execution, cancellation,
  retries, context budgeting, recovery from provider failures, and long-running
  multi-tool tasks.
- A safe tool system with explicit side-effect classes, approval policy hooks,
  audit events, deterministic input normalization, and replay protections.
- Context engineering for pruning, compaction, summary checkpoints, tool result
  management, and long-task continuity.
- OpenClaw capability coverage primitives so Moss can govern desktop, board,
  browser, attachment, channel, task, memory, and OpenClaw-channel tools without
  making users reason about a separate agent tier. See
  [Moss OpenClaw Capability Coverage Goal](board-agent-convergence.md).
- Knowledge, memory, skills, and teaching primitives that are explainable,
  testable, optional, and host-controlled.
- Open-source boundary governance so public Moss packages do not absorb
  RDK Studio product code, private credentials, deployment policy, desktop UI,
  or host-owned integrations.

## Non-Goals

Moss is not the RDK Studio product shell. It should not own Electron UI, desktop
settings, account flows, private deployment policy, model keys, device
passwords, or proprietary service defaults.

Moss is not a general IDE agent, a model gateway, a plugin marketplace, or a
low-code application platform. It may support code and documentation workflows
when they serve robotics and edge-device engineering tasks, but the center of
gravity remains device-aware agent runtime infrastructure.

Moss should not hard-code one robot family or one vendor workflow into core
packages. RDK-specific behavior belongs in host adapters, knowledge modules,
platform extensions, or optional packages.

Moss should not treat memory, skills, or teaching as opaque magic. Stored
knowledge and learned behavior must be inspectable, testable, disabled when a
host opts out, and safe to exclude from minimal integrations.

## Six-Month Target

The six-month target is:

**Moss 0.6 is a robotics-grade agent runtime beta that can be embedded by at
least two real hosts through a stable Host Adapter v1 candidate.**

This target is met when:

- `npm run verify` runs in CI and genuinely covers open-source boundary checks,
  workspace builds, typechecks, and all package tests.
- `@rdk-moss/agent` has a single `test` entrypoint that includes the existing
  agent loop, context, tool, provider, safety, and session tests.
- `@rdk-moss/memory`, `@rdk-moss/skills`, and `@rdk-moss/teaching` have focused unit
  tests for their public behavior before they are treated as release-ready
  packages.
- Host Adapter v1 candidate compatibility checks pass for RDK Studio and at
  least one minimal external host.
- Built-in tools declare side-effect metadata and produce approval/audit events
  that hosts can enforce consistently.
- The pi-ai bridge is isolated to provider adapter boundaries; the core runtime
  exposes Moss-owned LLM and streaming abstractions.
- Three representative workflows are covered by repeatable smoke tests or
  scenario tests: device diagnostics, code/workspace modification, and
  documentation or knowledge lookup.
- Release notes record host adapter impact, verification commands, and RDK
  Studio consumption status.

## Current Gate

The authoritative local and CI gate is `npm run verify`. It runs open-source
boundary checks, workspace hygiene checks, workspace builds, typechecks, and
recursive package tests, including nested e2e replay scenarios under package
test directories.

Host Adapter acceptance is covered by the `@rdk-moss/core` conformance suite and
the `@rdk-moss/agent` fixture host. Both run through the package test entrypoints
and therefore through the root gate.

Dead-code cleanup remains a separate audit-backed lane: prove a symbol is unused
with source search, build/typecheck output, import/export checks, and tests
before deleting it.

## Next Target

The next optimization target is stable host integration with an observable
runtime and a dead-code-free public surface. Keep Host Adapter, telemetry, mesh
events, OpenClaw capability coverage, and public exports contract-first; keep
deletion work isolated from feature work.

## Phases

### Phase 1: Trustworthy Project Hygiene

Make verification meaningful before expanding the framework.

- Add unified package test scripts, starting with `@rdk-moss/agent`.
- Ensure root `npm run verify` fails when any package test fails or is missing
  unexpectedly.
- Add CI for install, boundary checks, build, typecheck, and tests.
- Reconcile Node engine requirements across root docs and package manifests.
- Fix documentation links to examples by adding the examples or removing claims
  that they exist.

### Phase 2: Runtime Kernel Consolidation

Reduce maintenance risk in the core runtime.

- Keep `runAgentLoop` as the shared execution kernel.
- Shrink `DmossAgent` toward a thin host-facing wrapper.
- Move provider-specific types behind Moss-owned runtime interfaces.
- Keep context management, compaction, tool execution, and stream conversion in
  focused modules with tests around their public behavior.

### Phase 3: Host Adapter And Tool Safety

Turn the host boundary into the primary product surface.

- Promote the Host Adapter contract to a v1 candidate.
- Require hosts to declare capability kinds, provider families, tool names,
  side-effect classes, approval boundaries, and event schemas.
- Add compatibility tests for RDK Studio and a minimal sample host.
- Add metadata to built-in tools so hosts can distinguish readonly work from
  local writes, device mutation, credential access, external messaging, memory
  writes, runtime state changes, and subagent activity.

### Phase 4: Explainable Learning Primitives

Advance memory, skills, and teaching only after the runtime is dependable.

- Define small public behaviors for memory selection, skill candidates, skill
  validation, skill promotion, and teaching annotations.
- Add tests for those behaviors before adding broader automation.
- Keep every learning mechanism opt-in and inspectable by the host.
- Favor deterministic scoring and validation over broad automatic behavior
  changes.

## Decision Rules

When deciding whether a feature belongs in Moss, ask:

1. Does this strengthen the host-neutral robotics-grade runtime?
2. Can a product host inject policy, storage, credentials, and UI instead of
   Moss owning them?
3. Can the behavior be tested without RDK Studio private services?
4. Does it improve reliability, safety, observability, or long-task continuity?
5. Would adding it make the Host Adapter clearer rather than leak product code
   into the runtime?

If the answer is no, the feature should live in a host, an optional extension,
or a separate package rather than the Moss core.
