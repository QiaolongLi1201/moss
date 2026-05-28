# Moss

Moss is the host-neutral agent runtime extracted from RDK Studio. It is designed
to evolve as an open-source package set while product hosts keep their own UI,
credentials, device integrations, private services, and deployment policy.

The practical goal is simple: a host such as RDK Studio should usually get a new
conversation experience by updating the Moss packages or the `external/moss`
submodule. Host code changes should be needed only when the Host Adapter
contract changes or when Moss explicitly requires new host capabilities.

## Repository Scope

This repository contains the parts of Moss that can be maintained independently
from a product shell.

| Package | Role |
| --- | --- |
| `@dmoss/core` | Public contracts, platform extension types, Host Adapter contract, and robotics prompts |
| `@dmoss/agent` | Agent runtime, tool loop, context management, safety helpers, skills, and provider adapters |
| `@dmoss/memory` | Context-aware memory selection and memory draft helpers |
| `@dmoss/skills` | Skill learning, validation, scoring, and promotion helpers |
| `@dmoss/teaching` | Teach-while-solve annotations and tool digest helpers |
| `create-dmoss-app` | Minimal project scaffolding for external Moss users |

RDK Studio is one host for Moss. It is not part of this repository.

## Architecture

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

The agent runtime should not import product code. Product hosts inject concrete
providers, tools, storage, approval handling, knowledge modules, and event
transports.

## Host Adapter Contract

The public contract lives in:

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@dmoss/core/contracts/host-adapter';
```

A host declares:

- Host id, name, and version.
- Moss package versions it is consuming.
- Capabilities such as `llm_provider`, `tool_registry`, `approval_gate`,
  `event_sink`, `memory`, `knowledge`, `device_runtime`, and `channel_runtime`.
- Provider families supplied by the host.
- Tool names and permission boundaries.
- Event schemas and knowledge modules.

Moss releases use `evaluateMossHostCompatibility()` to decide whether the host
can consume the release unchanged.

Read the detailed contract guide:

- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md)

## Project Goal And Roadmap

Moss is being developed as a robotics-grade, host-neutral agent runtime. The
roadmap defines the north star, non-goals, six-month target, and phase plan:

- [`docs/roadmap.md`](docs/roadmap.md)

## Maintainer Guides

These documents are intended to be durable project manuals, not session notes:

- [`AGENTS.md`](AGENTS.md): agent working rules, architecture-review discipline,
  CodeGraph usage, and bug-fix checklists for this repository.
- [`ARCHITECTURE_ASSESSMENT.md`](ARCHITECTURE_ASSESSMENT.md): current
  architecture findings, rejected hypotheses, and "do not change" decisions.
- [`CLEAN_CODE_ASSESSMENT.md`](CLEAN_CODE_ASSESSMENT.md): code quality review
  and cleanup guidance.
- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md): Host
  Adapter contract guide.
- [`docs/tool-runtime.md`](docs/tool-runtime.md): tool execution pipeline,
  ownership boundaries, hooks, approval, timeout, and guard limits.
- [`docs/tool-side-effect-idempotency-rfc.md`](docs/tool-side-effect-idempotency-rfc.md):
  RFC for in-flight deduplication of non-idempotent tools.
- [`docs/release-checklist.md`](docs/release-checklist.md): release validation
  and host update checklist.

Historical phase notes such as [`docs/goals-phase-5.md`](docs/goals-phase-5.md)
and [`docs/goals-phase-6.md`](docs/goals-phase-6.md) can help explain why the
current contracts and tests exist, but the roadmap and release checklist are the
source of truth for new work.

## Architecture Review Discipline

Do not turn open-ended reviews into endless issue lists. A candidate issue is
worth fixing only when it blocks a committed goal, a real host path, safety,
data correctness, resource lifecycle, or a contract that downstream users rely
on. Style concerns, framework feature comparisons, and speculative future
abstractions should be recorded as observations or rejected explicitly.

Before changing architecture, preserve this loop:

1. Generate hypotheses from the actual code and active host workflows.
2. Try to falsify each hypothesis by reading source, checking callers, tracing
   runtime flow, or running a focused test.
3. Fix bugs with declare + enforce + test. Existing tests are regression
   checks; the fix still needs a test that would have failed before the change.
4. Document "do not touch" conclusions when a suspicion is falsified, so future
   reviews do not spend time re-litigating the same point.

## What Does Not Belong In Moss

Keep product-specific code in the host repository.

Do not add:

- RDK Studio `server/**`, `src/**`, or `electron/**` code.
- Product configuration defaults, local sessions, logs, or generated desktop
  artifacts.
- Supabase keys, model keys, image provider keys, device passwords, SSH
  credentials, or user account details.
- Host-owned integrations such as OpenClaw deployment, Feishu, Weixin, desktop
  IPC, Electron packaging, or RDK Studio settings UI.
- Built `dist/` directories as tracked source.

RDK-specific domain knowledge may live in a separate optional package. The Moss
core packages should stay useful to other robotics or device-product hosts.

## Development

Use Node 22.16 or newer for this workspace.

```bash
npm install
npm run verify
```

`npm run verify` runs:

1. Open-source boundary checks.
2. Workspace hygiene checks for Node engine consistency, package test scripts,
   and local Markdown links.
3. Workspace builds.
4. Typechecks.
5. Package tests.

The boundary check can be run directly:

```bash
npm run check:boundaries
```

## Integrating Moss Into A Host

1. Install or vendor the relevant Moss packages.
2. Keep credentials and product-specific defaults in the host.
3. Register host providers, tools, storage, approval gates, and event sinks with
   the agent runtime.
4. Publish a `MossHostRuntimeManifest` from the host adapter.
5. Run `evaluateMossHostCompatibility()` in CI before adopting a new Moss
   release.

For RDK Studio, the host adapter lives in the RDK Studio repository and is
validated by its `moss:update` flow.

## Version Policy

Moss follows semver for the public package surface.

- Patch releases fix bugs or improve internals without requiring host adapter
  changes.
- Minor releases may add optional fields, optional capabilities, or new helper
  APIs. Existing hosts should continue to work.
- Major releases may change required Host Adapter fields or required
  capabilities. Hosts must update their adapter before adopting the release.

For RDK Studio specifically, a Moss patch or minor update should normally be a
submodule/package update plus validation. Adapter changes are required only when
`MOSS_HOST_ADAPTER_CONTRACT_VERSION` changes incompatibly or a release declares
new required host capabilities, event schemas, or provider families.

## Release Checklist

Every Moss release must pass the release checklist:

- [`docs/release-checklist.md`](docs/release-checklist.md)

At minimum, maintainers run:

```bash
npm run verify
```

If the release is intended for RDK Studio, update `external/moss` in the Studio
repository and run the host upgrade verification there.
