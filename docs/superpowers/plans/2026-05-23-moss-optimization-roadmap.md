# Moss Optimization Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Moss into a contract-first, observable runtime with an authoritative verification gate, a stable host-adapter surface, and a separate dead-code removal lane that deletes only code proven to be unused.

**Architecture:** Keep the current package split. Treat `@rdk-moss/core` as the public contract layer, `@rdk-moss/agent` as the runtime kernel, and `scripts/` + CI as the release gate. Make verification recursive and scenario-aware, wire observability into the main runtime path, and run dead-code cleanup as its own audit-backed lane so deletions never get mixed with feature work.

**Tech Stack:** Node 22.16+, npm workspaces, TypeScript, node:test / `.spec.mjs`, GitHub Actions, existing Moss verification scripts.

---

### Task 1: Make verification authoritative

**Files:**
- Modify: `scripts/run-package-tests.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Test: `packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs`

- [x] **Step 1: Expand test discovery to include nested package tests**
- Change package test discovery so `packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs` is included.
- Keep the current top-level `.spec.mjs` convention intact for existing files.
- Status: `scripts/run-package-tests.mjs` now recursively collects `*.spec.mjs`, so `packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs` is included by `npm run verify`.

- [x] **Step 2: Align CI with the declared Node floor**
- Make CI match `engines.node` or explicitly change `engines.node` if the support policy really includes older Node versions.
- Remove matrix legs that are outside the declared support contract.
- Status: `.github/workflows/ci.yml` runs `npm run verify` on Node `22.16.0`, matching the declared `engines.node` floor.

- [x] **Step 3: Verify the gate really runs the intended coverage**
- Run: `npm run verify`
- Run: `node packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs`
- Expected: the e2e scenario is part of the authoritative gate or is intentionally split into a named gate with clear CI coverage.
- Status: verified locally; the package test runner prints `packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs` during `npm run verify`.

### Task 2: Harden the Host Adapter contract

**Files:**
- Modify: `packages/dmoss/src/contracts/host-adapter.ts`
- Modify: `packages/dmoss/test/host-adapter-conformance.spec.mjs`
- Modify: `packages/dmoss-agent/test/fixture-host.mjs`
- Modify: `docs/host-adapter-contract.md`

- [x] **Step 1: Keep the contract executable, not just descriptive**
  - Ensure the compatibility checks stay the single source of truth for host acceptance.
  - Keep failure modes explicit and stable.
  - Status: `packages/dmoss/src/contracts/host-adapter.ts` now supports exact contract matches, compatible version ranges, and `invalid_manifest` handling.

- [x] **Step 2: Expand fixture-host coverage**
  - The fixture host should remain the canonical minimal host example.
  - Add/keep coverage for manifest shape, compatibility reporting, and strict requirements.
  - Status: `packages/dmoss-agent/test/fixture-host.mjs` now checks contract range negotiation in addition to strict compatibility.

- [x] **Step 3: Verify against both the conformance suite and fixture host**
  - Run: `node packages/dmoss/test/host-adapter-conformance.spec.mjs`
  - Run: `node packages/dmoss-agent/test/fixture-host.mjs`
  - Expected: both stay green after contract changes.
  - Status: verified locally; both suites pass with the new contract negotiation and invalid-manifest handling.

### Task 3: Wire runtime observability into the hot path

**Files:**
- Modify: `packages/dmoss-agent/src/core/agent-loop.ts`
- Modify: `packages/dmoss-agent/src/core/dmoss-agent.ts`
- Modify: `packages/dmoss-agent/src/core/subagent-orchestrator.ts`
- Modify: `packages/dmoss-agent/src/observability/index.ts`
- Modify: `packages/dmoss-agent/src/observability/tracing.ts`
- Modify: `packages/dmoss-agent/src/observability/llm-usage.ts`
- Modify: `packages/dmoss-agent/src/observability/redact.ts`
- Modify: `packages/dmoss-agent/src/mesh/mesh-events.ts`
- Modify: `packages/dmoss-agent/src/mesh/agent-mesh.ts`
- Modify: `packages/dmoss-agent/src/cli.ts`

- [x] **Step 1: Attach event and telemetry plumbing to the real runtime path**
  - Make the main agent loop emit spans and usage records in the same place it already handles turns/tools/retries.
  - Keep redaction as the default before any telemetry leaves the runtime.
  - Status: `packages/dmoss-agent/src/core/agent-loop.ts` emits `agent.llm_turn` spans and usage logging; the bridge smoke test confirms the runtime path is hit.

- [x] **Step 2: Make mesh and subagent events actually flow**
  - Wire `MeshEventBus` into the CLI/runtime path.
  - Emit the structured events that are already defined instead of leaving them as dormant types.
  - Status: `packages/dmoss-agent/src/core/subagent-orchestrator.ts` emits `child_run_*` events and `packages/dmoss-agent/src/cli.ts` wires mesh logging with redaction.

- [x] **Step 3: Verify through existing tests plus one smoke path**
  - Re-run the agent package tests and the e2e replay.
  - Expected: observability stays helper-level in tests, but the runtime now has production call sites.
  - Status: verified with `npm run verify` and the bridge smoke test for span, usage, and redaction coverage.

### Task 4: Tighten the public API surface

**Files:**
- Modify: `packages/dmoss-agent/src/index.ts`
- Modify: `packages/dmoss-agent/src/core/index.ts`
- Modify: `packages/dmoss-agent/package.json`
- Modify: `packages/dmoss-agent/API.md` if export docs need syncing

- [x] **Step 1: Decide which orchestration helpers are public**
- Either export `subagent-orchestrator` as an intentional API or keep it internal and document that choice.
- Make the exports and docs agree.
- Status: `subagent-orchestrator` stays internal; `API.md` documents the internal boundary and points hosts to stable subpaths instead.

- [x] **Step 2: Keep the public surface small and explicit**
- Avoid exposing helpers that are only needed by internal wiring.
- Preserve stable exports that hosts already depend on.
- Status: root exports remain focused on the runtime harness; `@rdk-moss/agent/mesh` and `@rdk-moss/agent/observability` are documented as subpath-only public surfaces.

### Task 5: Delete dead / obsolete code in audit-backed batches

**Files:**
- Modify: any source file only after the symbol is proven unused
- Do not touch: public contracts, vendored `external/**`, or compatibility shims without proof

- [x] **Step 1: Audit before deleting**
  - Prove unused symbols with `rg`, TypeScript build output, import/export checks, and test coverage.
  - Treat public exports, docs examples, and fixture code as protected until proven otherwise.
  - Status: audited the helper-module candidates and narrowed deletion to unreferenced internal modules only.

- [x] **Step 2: Delete only what is truly dead**
  - Remove duplicate helpers, orphaned exports, obsolete branches, and stale compatibility code.
  - Do not fold this into unrelated refactors.
  - Status: removed unreferenced helper modules and kept fixture-backed / documented internals intact.

- [x] **Step 3: Verify after each deletion batch**
  - Run: `npm run check:boundaries`
  - Run: `npm run check:hygiene`
  - Run: `npm run verify`
  - Expected: no removed symbol is still referenced, and no contract or host integration regresses.
  - Status: verified locally; the full gate passes after the dead-code batch.

### Task 6: Release the optimized state with clear gates

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `docs/goals-phase-6.md`
- Modify: release notes or changelog files as needed

- [x] **Step 1: Record what the new gate covers**
  - Document the authoritative test gate, the host contract checks, and the dead-code audit rule.
  - Status: `docs/roadmap.md` and `docs/goals-phase-6.md` now record `npm run verify`, nested e2e coverage, host adapter conformance, fixture host coverage, and the audit-backed dead-code rule.

- [x] **Step 2: Make the next optimization target explicit**
  - The next milestone should be framed as “stable host integration with observable runtime and dead-code-free surface,” not as a grab bag of features.
  - Status: `docs/roadmap.md` now frames the next optimization target as stable host integration with an observable runtime and a dead-code-free public surface.

---

## Coverage Check

- Host contract hardening maps to Tasks 2 and 6.
- Verification gap maps to Task 1.
- Observability and mesh/runtime integration map to Task 3.
- Public API clarity maps to Task 4.
- Dead-code removal maps to Task 5.

## Ordering

1. Fix the verification gate.
2. Harden the host contract.
3. Wire observability into the runtime path.
4. Tighten exports.
5. Delete dead code in audited batches.
6. Update roadmap and release docs.
