# AGENTS.md

Instructions for AI agents in the moss repository. Tool-agnostic; `CLAUDE.md` is the Claude-specific copy. Keep the two aligned when editing shared rules.

## Project Overview

Moss is a vendor-neutral robotics agent framework (TypeScript, ESM, npm-workspaces monorepo). Node >= 22.16.0.

| Package | npm name | Purpose |
|---|---|---|
| `packages/dmoss` | `@rdk-moss/core` | Core contracts: KnowledgeModule, PlatformExtension, VendorPlugin, robotics prompts |
| `packages/dmoss-agent` | `@rdk-moss/agent` | Standalone agent runtime: knowledge modules, platform extensions, tool framework |
| `packages/dmoss-memory` | `@rdk-moss/memory` | Context-aware memory selection, self-learning memory drafts |
| `packages/dmoss-skills` | `@rdk-moss/skills` | Skill learning pipeline: candidate store, scorer, distiller, promoter |
| `packages/dmoss-teaching` | `@rdk-moss/teaching` | Teach-while-solve annotation layer |
| `packages/create-dmoss-app` | `create-dmoss-app` | Project scaffolding CLI |

Key docs: `ARCHITECTURE_ASSESSMENT.md` (current findings + don't-touch list), `docs/roadmap.md`, `docs/host-adapter-contract.md`.

## Scope Guard

Moss is a host-neutral robotics agent runtime: hosts own UI, model keys, credentials, storage, and deployment policy; moss owns the runtime core (`docs/roadmap.md`). Before adding any feature, apply the roadmap decision rules — does it strengthen the host-neutral runtime; can the host inject policy/storage/credentials/UI instead of moss owning them; is it testable without private product-host services; does it improve reliability/safety/observability/long-task continuity; does it make the Host Adapter clearer rather than leak product code into the runtime? Any "no" → it belongs in a host, an optional extension, or a separate package — not moss core. Never hard-code a robot family or vendor workflow into core packages; RDK-specific behavior goes in host adapters, knowledge modules, or platform extensions.

## Commands

```bash
npm run build              # clean + build all workspaces
npm run typecheck          # all workspaces
npm run test               # all packages (each test run builds first)
npm run test -w @rdk-moss/core   # single package
npm run lint / lint:fix
npm run verify             # boundaries + hygiene + build + typecheck + lint + test — run before claiming work done
```

Tests are `.spec.mjs` files under each package's `test/`, run by `scripts/run-package-tests.mjs`. Strictness lives in root `tsconfig.base.json` — never copy compiler options into a package tsconfig.

## Boundaries & Invariants

Enforced by `check:boundaries` + `check:hygiene` (both inside `verify`). Know them upfront; if a check fails, fix the content — never weaken the check.

**OSS boundaries** (`scripts/check-oss-boundaries.mjs`): public packages must never contain imports from product-host paths (`server/`, `electron/`, `config/`), real credentials / API keys / internal IPs / personal identifiers (even in comments, tests, or docs — use the allowlisted fake placeholders), product-host defaults files, or committed `dist/`.

**Workspace invariants** (`scripts/check-workspace-hygiene.mjs`):

- `engines.node` in every package must equal root
- every package must have `scripts.test`
- bumping `@rdk-moss/core` version requires syncing `DEFAULT_MOSS_VERSION_RANGE` (`^<version>`) in `packages/create-dmoss-app/index.mjs`
- markdown links incl. anchors must resolve — when moving/renaming docs, fix every inbound link
- dynamically built ESM import paths must go through `pathToFileURL(...).href` (Windows compat)

**API stability**: all 6 packages publish publicly. Mark new exports with TSDoc `@public`/`@beta`/`@internal` (`@internal` is not semver-protected). The Host Adapter contract (`@rdk-moss/core/contracts/host-adapter`) is versioned — changing manifest shape or compatibility behavior requires a contract-version review (`docs/host-adapter-contract.md`). The deprecated global-registry family is alive in downstream hosts; deleting it breaks production.

## Task Execution Strategy

Before starting any multi-item task list, classify (mandatory, ~30s):

1. **Independent tasks** (no shared state, no file conflicts) → dispatch as parallel agents immediately
2. **Dependent tasks** → serial, in dependency order
3. **Small tasks** → do directly while parallel agents run

Never execute 3+ independent tasks serially. Track multi-step work with a todo/task list.

**Don't delegate what CodeGraph already indexed**: for structural/code-navigation questions, answer directly with 2-3 CodeGraph calls instead of spawning a file-reading sub-agent or running a grep + read loop — that repeats work the graph already did.

## CodeGraph

A CodeGraph MCP server (`codegraph_*` tools) provides a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and structural — they return what grep cannot.

**Tool choice**: CodeGraph for *structural* questions (what calls what, what breaks, where is X defined, signatures). Native grep/file reads for *literal text* (strings, comments, log messages, config, generated files, docs) or when you already have the file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / find symbol | `codegraph_search` |
| "What calls Y?" / "What does Y call?" | `codegraph_callers` / `codegraph_callees` |
| "How does X reach Y? / trace the flow" | `codegraph_trace` (one call = whole path, incl. callback/React/JSX dynamic hops) |
| "What breaks if I change Z?" | `codegraph_impact` |
| "Y's signature / source / docstring" | `codegraph_node` |
| "Focused context for a task/area" | `codegraph_context` |
| "Source of several related symbols" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

Rules of thumb:

- **Minimal call patterns**: architecture question = `codegraph_context` → ONE `codegraph_explore`. Flow question = `codegraph_trace` from→to → ONE `codegraph_explore` for bodies. Don't rebuild paths with search + callers; don't loop `codegraph_node` over many symbols (`codegraph_explore` batches them); don't chain search + node when `codegraph_context` is one call.
- **Trust results for navigation** — they come from a full AST parse; don't re-verify with grep. But **read the actual source files before editing** — the graph is a map, not the patch authority.
- **Don't grep first** for a symbol by name; `codegraph_search` returns kind + location + signature in one call.
- **Scope caveat**: "no callers found" means none *within the index*. Cross-repo callers, downstream consumers, and external scripts are invisible — grep the full workspace before declaring dead code.
- **Index lag**: watcher debounces ~500ms behind writes; don't re-query immediately after editing in the same turn. If results look stale or surprising, check `codegraph_status`, then verify with the narrowest source read.
- **If `.codegraph/` doesn't exist**: the server returns "not initialized." Ask the user: *"Want me to run `codegraph init -i` to build the index?"* Don't auto-initialize in scratch directories.

## Architecture Evaluation Principles

When evaluating moss's architecture, suggesting improvements, or comparing with other frameworks:

### 1. No feature-checklist thinking

Don't compare moss against LangChain/LangGraph/CrewAI/AutoGen by listing features they have. Mainstream frameworks advertise capabilities that often don't deliver, and moss may solve the same problem differently. A DAG engine or vector-store layer only matters if a concrete moss scenario demands it. Start from moss's actual code; work outward from real bugs and friction, not inward from feature lists.

### 2. Evidence before claims

Every architectural finding must cite source (`file:line`). Read the implementation before calling it a gap; check callers before calling it dead code; trace control flow before calling it a bug. No citation = hypothesis, not conclusion.

### 3. Falsify before reporting

For each suspected problem, actively try to kill it first: Could moss already handle this in a way you missed? Is the "mainstream" solution actually better, or just more abstract? Does the abstraction add more complexity than it removes? Is the problem real for moss's use cases (robotics agent, device management) or only theoretical? Unfalsified → report as hypothesis with evidence for and against.

### 4. Priority order

1. Silent bugs (wrong behavior under concurrency, edge cases, contract violations)
2. Contract violations (module doesn't do what its interface promises)
3. Dead code and confusion (cognitive load for humans and AI)
4. Missing capabilities — only with a concrete demanding scenario

Never add a framework, abstraction, or module just because it's common elsewhere.

### 5. Three-phase assessment

For non-trivial evaluations (example: `ARCHITECTURE_ASSESSMENT.md`):

1. **Hypothesis generation** — initial scan, label everything as hypothesis
2. **Adversarial verification** — falsify by reading source, checking callers, tracing flows; expect 2-3 of every 8 findings to die here
3. **Evidence-based conclusion** — report only source-cited findings; explicitly list what was rejected and why

### 6. "Don't touch" is a valid finding

Explicitly identify well-designed things that must not change, so future sessions don't re-propose the same bad ideas. Current list: `ARCHITECTURE_ASSESSMENT.md` §4.

### 7. Architecture brainstorming workflow

Trigger for: architecture evaluation, roadmap cleanup, multi-agent review synthesis, "what else is wrong", "what should we fix next", broad refactor proposals.

1. **Diverge, then judge.** Generate concerns from 3+ viewpoints: moss maintainer, current downstream host, minimal future external host. Keep all as hypotheses until evidence lands.
2. **Classify**: A = blocks current goal or committed roadmap item; B = may block a plausible future, nobody blocked today; C = taste/style/framework-comparison drift.
3. **Five rejection gates** — downgrade unless it survives all: *Roadmap* (which committed goal does it block?), *Host* (which real host can hit it?), *Cost* (data loss / security / silent wrong behavior / leak / hard evolution block?), *Anti-speculation* (general resilience vs. predicting an uncommitted future?), *Survival* (has the design already survived production without this failure?).
4. **Four outcomes**: Fix now (silent bug, contract violation, safety, leak, or cheap doc preventing real misuse) · Measure first (perf/scale claims without numbers) · Defer with a written reopening trigger · Do not fix (style, abstraction preference, "framework X does it").
5. **Record rejections.** Every assessment must include "do not touch" and "deferred until trigger" items — otherwise each later session rediscovers the same non-problems.

For multi-agent review, give agents distinct roles (maintainer simplicity / downstream-host delivery risk / external-host onboarding / contrarian "why not fix this"), not the same broad question. The coordinator owns the final call and cites evidence for every fix-now item.

## Bug Fix Discipline: Declare + Enforce + Test

A fix involving contracts, interfaces, or invariants is complete only when all three are done:

1. **Declare** — change the structure (field, class, type)
2. **Enforce** — make the runtime actually read and act on the declaration
3. **Test** — write a test that fails before the fix and passes after

### Failure modes to avoid

- **Refactoring disguised as bug fix** — restructuring (e.g., wrapping globals in a class) without verifying runtime behavior changed
- **Wiring half the path** — converting free functions to methods but missing call sites (e.g., wiring knowledge but forgetting vendor callbacks)
- **Declaring a capability nobody reads** — `capabilities: { streaming: false }` is useless until the caller branches on it
- **Running existing tests as proof** — they prove you didn't break things, not that you fixed the bug

### Before claiming a fix is complete

- Did I write a test that would have caught the original bug?
- Does runtime behavior actually differ, or does the source just look different?
- Did I trace the full data flow (input → processing → output)?
- Do deprecated callers still bypass the new path? If so, is that documented and observable (one-time warn log)?

### Instance-scoped refactoring checklist

When converting module-level state to instance state: (1) list every free function touching the state; (2) list every caller (CodeGraph + cross-repo grep); (3) decide shared singleton vs. per-instance; (4) singleton → add telemetry (warn on Nth instance); (5) per-instance → migrate all callers or document stragglers; (6) test with 2+ instances to prove isolation.

### Self-review checklist (mechanical — run every time)

1. **Declaration → reader grep**: every new field/type/interface, immediately grep for who reads it (e.g., `rg "capabilities\.streaming"`). No reader = documentation, not behavior.
2. **Changed A → scan siblings**: grep the original free-function names (e.g., `rg "setVendorPluginCallbacks|setKnowledgeRegistryForExtensions"`) to build the migration checklist.
3. **Red before green**: write the failing test first, watch it fail, then implement. A test written after the code tests what you wrote, not what should be.
4. **Deprecated needs observability + deadline**: `@deprecated` without a one-time warn log, a call counter, and a target removal version is a permanent API.
5. **Tool boundary awareness**: "no callers found" = none in scope. Grep the full workspace root before declaring dead code.
6. **Spec as checklist**: for each spec/assessment action item — grep the implementation, grep the reader, grep the test. Three greps per item, zero reliance on memory.

### Async resource lifecycle pitfalls

When wrapping OS resources (child processes, sockets, file handles) in Promises:

- **Check `signal.aborted` before starting the resource** — a pre-aborted signal never fires the `abort` listener; short-circuit with `if (signal?.aborted) return reject(...)`
- **Single `cleanup()`** called from `close`, `error`, and timeout paths — no listener leaks
- **SIGKILL, not SIGTERM** — SIGTERM can be caught/ignored; for robotics tools where a hung SSH session blocks the event loop, SIGKILL is the right default

## Tool Safety & Paid-for Lessons

Each rule below regressed at least once (P0s in `ARCHITECTURE_ASSESSMENT.md` / `CLEAN_CODE_ASSESSMENT.md`). Don't reintroduce the class:

- **No new module-level mutable state in library packages.** Module-level singletons (extensions/registry, command-queue) broke multi-agent isolation — two past P0s. State lives on instances; a deliberate process-wide singleton needs a design-intent comment (cf. keep-alive-dispatcher) and a 2+-instance isolation test.
- **Child processes only via `utils/run-process.ts`** (spawn + AbortSignal + timeout + maxBuffer). `execFileSync`/`execSync` in tool execution paths blocks the event loop and silently disables cancellation — past P0 across 4 device-tool files.
- **New tools declare side-effect metadata.** Readonly vs mutating drives approval/audit/replay policy. Non-repeatable mutations (`device_exec`, device writes, `ros2_service_call`, …) are `idempotent: false` — contract in `docs/tool-side-effect-idempotency-rfc.md`.
- **Non-streaming LLM providers declare `capabilities: { streaming: false }`.** The stream adapter branches on it; faking a stream from a complete response was a past P0.
- **Tool errors go through `DmossError`/`wrapAsDmoss`**, never bare `new Error()` or `catch (err: any)`.

## Engineering Patterns & Anti-Patterns

1. **Discoverability is part of the PR.** Every user-facing subsystem must be re-exported from the main barrel (`src/index.ts`). If `package.json` exports a subpath (`./mcp`, `./observability`), the barrel needs a matching export or an explicit `@internal` note. Users discover capabilities through the barrel, not `package.json`.
2. **Fix one = fix the class.** After any fix, ask "does this bug shape appear elsewhere?" and grep for siblings (e.g., fixed one missing barrel export → check all subpaths; fixed one catch block missing `wrapAsDmoss` → grep all catch blocks in the directory). Point-fixing turns reviewers into janitors.
3. **Cross-package config is aligned, not copied.** Strictness belongs in `tsconfig.base.json`; upgrading one package means upgrading the base so all inherit.
4. **`@deprecated` without a migration path = not written.** Required: `since` + removal-target version, link to `MIGRATION.md`, and a copy-pasteable before/after snippet (≤5 lines). The downstream developer should not need to think.
5. **`as unknown as X` = hidden type debt.** Every such cast needs either an immediate runtime check (`zod`/`assert`/`instanceof`) or a comment explaining why the compiler can't see the relationship. 16+ casts in one file = the type architecture needs an RFC, not a sed replacement.
