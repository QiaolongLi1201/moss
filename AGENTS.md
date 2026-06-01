# Moss Project Agent Instructions

## Task Execution Strategy

Before starting any multi-item task list, spend 30 seconds classifying:

1. **Independent tasks** (no shared state, no file conflicts) → dispatch as parallel agents immediately
2. **Dependent tasks** (one must finish before another starts) → serial, in dependency order
3. **Small tasks you can do directly** → do these while parallel agents run

Never execute 3+ independent tasks serially when they could run in parallel. The classification step is mandatory, not optional.

## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured. CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and file. Reads are sub-millisecond and return structural information grep cannot.

### When to prefer CodeGraph over native search

Use CodeGraph for **structural** questions — what calls what, what would break, where is X defined, what is X's signature. Use native grep/read only for **literal text** queries (string contents, comments, log messages) or after you already have a specific file open.

| Question | Tool |
|---|---|
| "Where is X defined?" / "Find symbol named X" | `codegraph_search` |
| "What calls function Y?" | `codegraph_callers` |
| "What does Y call?" | `codegraph_callees` |
| "How does X reach/become Y? / trace the flow from X to Y" | `codegraph_trace` (one call = the whole path, incl. callback/React/JSX dynamic hops) |
| "What would break if I changed Z?" | `codegraph_impact` |
| "Show me Y's signature / source / docstring" | `codegraph_node` |
| "Give me focused context for a task/area" | `codegraph_context` |
| "See several related symbols' source at once" | `codegraph_explore` |
| "What files exist under path/" | `codegraph_files` |
| "Is the index healthy?" | `codegraph_status` |

### Rules of thumb

- **Answer directly — don't delegate exploration.** For "how does X work" / architecture questions, answer with 2-3 CodeGraph calls: `codegraph_context` first, then ONE `codegraph_explore` for the source of the symbols it surfaces. For a specific **flow** ("how does X reach Y") start with `codegraph_trace` from→to — one call returns the whole path with dynamic hops bridged — then ONE `codegraph_explore` for the bodies; don't rebuild the path with `codegraph_search` + `codegraph_callers`. Codegraph IS the pre-built index, so spawning a separate file-reading sub-task/agent — or running a grep + read loop — repeats work CodeGraph already did and costs more for the same answer.
- **Trust CodeGraph results.** They come from a full AST parse. Do NOT re-verify them with grep — that's slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name. `codegraph_search` is faster and returns kind + location + signature in one call.
- **Don't chain `codegraph_search` + `codegraph_node`** when you just want context — `codegraph_context` is one call.
- **Don't loop `codegraph_node` over many symbols** — one `codegraph_explore` call returns several symbols' source grouped in a single capped call, while each separate node/Read call re-reads the whole context and costs far more.
- **Index lag**: the file watcher debounces ~500ms behind writes; don't re-query immediately after editing a file in the same turn.

### If `.codegraph/` doesn't exist

The MCP server returns "not initialized." Ask the user: *"I notice this project doesn't have CodeGraph initialized. Want me to run `codegraph init -i` to build the index?"*

## Architecture Evaluation Principles

When evaluating moss's architecture, suggesting improvements, or comparing with other frameworks, follow these rules:

### 1. No Feature Checklist Thinking

Do not compare moss against mainstream frameworks (LangChain, LangGraph, CrewAI, AutoGen, etc.) by listing features they have that moss doesn't. This produces misleading "gaps" that may not be real problems.

**Why**: mainstream frameworks advertise capabilities that often don't deliver in practice, and moss may already solve the same problem differently. A DAG engine, multi-provider abstraction, or vector store layer only matters if moss has a concrete scenario that demands it.

**Instead**: start from moss's actual code and find real bugs, real friction, real missing evidence. Work outward from problems, not inward from feature lists.

### 2. Evidence Before Claims

Every architectural finding must cite source code (file:line). Do not claim something is a problem based on file names, directory structure, or assumptions about what code "probably" does.

- Read the actual implementation before calling it a gap.
- Check callers before calling something dead code.
- Check the control flow before calling something a bug.
- If you can't cite the evidence, it's a hypothesis, not a conclusion.

### 3. Question Your Own Assumptions

When you identify a potential problem or gap, actively try to falsify it before reporting:

- Could moss already handle this in a way you missed?
- Is the "mainstream" solution actually better, or just more abstract?
- Would adding this abstraction create more complexity than it removes?
- Is the problem real for moss's actual use cases (robotics agent, device management), or only theoretical?

If you can't falsify it, state it as a hypothesis with the evidence for and against, not as a finding.

### 4. Fix Real Bugs Before Adding Features

Priority order:
1. **Silent bugs** that produce wrong behavior under specific conditions (concurrency, edge cases, contract violations)
2. **Contract violations** where a module doesn't do what its interface promises
3. **Dead code and confusion** that increases cognitive load for humans and AI
4. **Missing capabilities** only when there is a concrete scenario that demands them

Never suggest adding a framework, abstraction, or module just because it's common elsewhere.

### 5. Architecture Assessment Methodology

For non-trivial evaluations, use the three-phase approach (see `ARCHITECTURE_ASSESSMENT.md` for an example):

1. **Hypothesis generation**: initial scan, produce a list of suspected issues. Label them as hypotheses.
2. **Adversarial verification**: try to falsify each hypothesis by reading source, checking callers, tracing flows. Expect 2-3 out of every 8 initial findings to be wrong.
3. **Evidence-based conclusion**: only report findings backed by source citations. Explicitly list what was rejected and why.

### 6. "Don't Touch" Is a Valid Finding

When reviewing architecture, explicitly identify things that are well-designed and should not be changed. This prevents future sessions from re-proposing the same bad ideas. See `ARCHITECTURE_ASSESSMENT.md` §4 for the current "don't touch" list.

### 7. Moss Architecture Brainstorming Skill

Use this before turning an architecture review into another repair loop. The point is to decide what is a real Moss problem, what is only an observation, and what should explicitly not be changed.

Trigger this workflow when a task asks for architecture evaluation, roadmap cleanup, multi-agent review synthesis, "what else is wrong", "what should we fix next", or any broad refactor proposal.

1. **Diverge first, then judge.** Generate candidate concerns from at least three viewpoints: Moss maintainer, current downstream host, and a minimal future external host. Keep candidates as hypotheses until source or runtime evidence supports them.
2. **Classify the concern.**
   - A: blocks the current goal or a committed near-term roadmap item.
   - B: may block a plausible future direction, but no concrete host or user is blocked today.
   - C: is mostly taste, style, framework comparison, or "best practice" drift.
3. **Apply the five rejection gates.** Downgrade the concern unless it survives all five:
   - Roadmap gate: which committed Moss/downstream-host goal does this block?
   - Host gate: which real host or integration path can hit it?
   - Cost gate: is the cost data loss, security risk, silent wrong behavior, leak, or hard evolution block?
   - Anti-speculation gate: does the fix add general resilience, or does it predict an uncommitted future?
   - Survival gate: has the current design already survived production use without the alleged failure?
4. **Choose one of four outcomes.**
   - Fix now: silent bug, contract violation, safety issue, leak, or low-cost documentation that prevents real misuse.
   - Measure first: performance, scale, or reliability concern without numbers.
   - Defer with trigger: future-evolution concern; write the concrete trigger that reopens it.
   - Do not fix: style-only concern, abstraction preference, or "mainstream frameworks do X" comparison without a Moss scenario.
5. **Record rejected ideas.** A good assessment must include "do not touch" and "deferred until trigger" items. This prevents every later agent from rediscovering the same non-problems and extending the bug-hunting loop forever.

When using multi-agent review, assign distinct roles instead of asking several agents the same broad question: maintainer simplicity, downstream-host delivery risk, external-host onboarding, and contrarian "why not fix this" review. The coordinator owns the final call and must cite evidence for every fix-now item.

## Bug Fix Discipline: Declare + Enforce + Test

When fixing a bug, especially one involving contracts, interfaces, or architectural invariants, the fix is not complete until all three steps are done:

1. **Declare**: change the structure (add a field, extract a class, add a type).
2. **Enforce**: make the runtime actually read and act on the declaration.
3. **Test**: write a test that would have failed before the fix and passes after.

Skipping enforce or test means the bug is still present at runtime, even if the code "looks fixed."

### Common failure modes

- **Refactoring disguised as bug fix**: restructuring code (e.g., wrapping globals in a class) without verifying the runtime behavior changed. The bug was about behavior, not structure.
- **Wiring only half the path**: when converting free functions to instance methods, trace every call site. If you wire knowledge but forget vendor callbacks, the fix is incomplete.
- **Declaring a capability nobody reads**: adding `capabilities: { streaming: false }` to an interface is useless if the caller never checks it. The adapter must branch on the capability.
- **Running existing tests as verification**: existing tests prove you didn't break things. They don't prove you fixed the bug. Write a test that exercises the specific broken behavior.

### Before claiming a fix is complete

Ask:
- Did I write a test that would have caught the original bug?
- Does the runtime actually behave differently now, or does it just look different in the source?
- Did I trace the full data flow (input → processing → output), or just the part I changed?
- Are there deprecated callers that still bypass the new path? If so, is that documented and observable (e.g., a one-time warn log)?

### Instance-scoped refactoring checklist

When converting module-level state to instance state:
1. List every free function that touches the state.
2. List every caller of each free function (use CodeGraph + cross-repo grep).
3. Decide: shared singleton (backward compat) or per-instance isolation?
4. If shared singleton: add telemetry (warn on Nth instance) so migration pressure is visible.
5. If per-instance: migrate all callers, or document which ones still use the old path.
6. Write a test with 2+ instances to prove isolation (or document the shared-singleton limitation).

### Self-Review Checklist (before submitting any fix)

These are mechanical steps that don't require experience — just discipline. Run them every time before claiming a fix is done.

1. **Declaration → reader grep**: for every new field, type, or interface added, immediately `rg` for who reads it. If nobody reads it, the fix is documentation, not behavior.
   ```
   rg "capabilities\.streaming" --type ts
   ```

2. **Changed A → scan siblings**: when refactoring one part of a struct/class, list all sibling fields and check each one is wired. Use `rg` on the original free function names to build a migration checklist.
   ```
   rg "setVendorPluginCallbacks|setKnowledgeRegistryForExtensions" --type ts -l
   ```

3. **Red before green**: write the test that asserts the expected behavior FIRST, run it (must fail), then implement. If you write the test after the code, it tests what you wrote, not what should be. Red is signal, not failure.

4. **Deprecated needs observability + deadline**: a `@deprecated` tag without telemetry (warn log, counter) and a target removal version is a permanent API. Add:
   - One-time `log.warn` on first call (with stack trace when feasible)
   - Counter for total calls (so migration progress is measurable)
   - Target version in the JSDoc (e.g., "removed in 0.5.0")

5. **Tool boundary awareness**: when a tool says "no callers found," that means "no callers found within the tool's search scope." Cross-repo callers, downstream consumers, and external scripts are invisible to CodeGraph/monorepo grep. Always `rg` the full workspace root before declaring something dead code.

6. **Spec as checklist**: when working from a spec or assessment document, treat each action item as a checkbox. For each item: grep for the implementation, grep for the reader, grep for the test. Three greps per item, zero reliance on memory.

### Async resource lifecycle pitfalls

When wrapping OS resources (child processes, sockets, file handles) in Promise-based APIs:

- **Check `signal.aborted` before starting the resource.** If you only register an `abort` event listener, a pre-aborted signal will never fire the listener and the resource will run to completion (or timeout). Always short-circuit: `if (signal?.aborted) return reject(...)`.
- **Clean up listeners in both success and failure paths.** Use a single `cleanup()` function called from `close`, `error`, and timeout handlers to avoid listener leaks.
- **Kill with SIGKILL, not SIGTERM.** SIGTERM can be caught/ignored by the child. SIGKILL is unconditional. For robotics tools where a hung SSH session blocks the event loop, SIGKILL is the right default.

## Engineering Patterns & Anti-Patterns

### 1. Discoverability is a pattern, not a task

Every new user-facing subsystem (observability, ToolHookRegistry, MCP, providers, etc.) **must** be re-exported from the main barrel (`src/index.ts`). This is part of the PR, not a follow-up.

**Rule**: if `package.json` exports a subpath (e.g., `./mcp`, `./observability`), the main barrel must have a corresponding `export` section or an explicit `@internal` annotation explaining why it's excluded.

**Anti-pattern**: implementing a feature, writing tests, registering the subpath export — but forgetting the main barrel. Users discover capabilities through the main barrel, not by reading `package.json`.

### 2. Fix one = fix the class

When fixing a bug, ask: **"Does this bug shape appear elsewhere?"** Then `rg` across the codebase for same-pattern instances.

**Example**: if you fix "subpath X not exported from main barrel," immediately check all other subpaths. If you fix "catch block doesn't use wrapAsDmoss," grep for all `catch` blocks in the same directory.

**Anti-pattern**: "point fixing" — fixing the one instance the reviewer pointed out without scanning for siblings. This turns reviewers into permanent janitors.

### 3. Cross-package config must be aligned, not per-package

Use a root `tsconfig.base.json` that all packages extend. Strictness settings (`noUnusedLocals`, `noUnusedParameters`, etc.) belong in the base, not copied per-package.

**Rule**: when upgrading strictness for one package, upgrade the base. All packages inherit automatically.

**Anti-pattern**: manually copying compiler options into each package's `tsconfig.json`. When one package gets stricter, others drift.

### 4. @deprecated without migration path = not written

A `@deprecated` JSDoc tag must include:
- `since` version and `removal target` version
- A link to `MIGRATION.md` with a before/after code snippet
- The before/after snippet must be copy-pasteable (5 lines max)

**Minimum standard**: the downstream developer should not need to think — just copy, paste, and delete the old code.

**Anti-pattern**: `@deprecated Use X instead.` — the reader still doesn't know how to change their code.

### 5. `as unknown as X` = hiding type debt

Every `as unknown as X` cast must satisfy one of:
1. Followed immediately by a runtime type check (`zod`, `assert`, `instanceof`)
2. A comment explaining **why the compiler can't see this relationship** (interface boundary, unexported type, third-party `.d.ts` bug)

**Rule**: bare casts without either of the above are not allowed. They will be flagged in code review.

**Anti-pattern**: using `as unknown as X` to "make TypeScript shut up" without understanding why the types don't align. This hides real architectural issues (e.g., SessionStore not being generic).

**When you see 16+ casts in one file**: this is a signal that the type architecture needs an RFC, not a batch sed replacement.

## CodeGraph Conservative Usage Overlay

- Prefer CodeGraph for structural code questions: definitions, signatures, callers, callees, traces, impact radius, and high-level task context.
- Keep using `rg`, direct file reads, and existing local tools for exact text, comments, log messages, configuration, generated files, docs, or when a specific file is already known.
- Before editing code, read the relevant source files directly even if CodeGraph found the symbols; use the graph as a map, not as the final authority for patches.
- If CodeGraph results look incomplete, stale, or surprising, check `codegraph_status`, allow for watcher lag after recent edits, and verify with the narrowest useful source inspection.
- Do not initialize indexes automatically in every scratch directory. Initialize with `codegraph init -i` only for repositories where structural navigation will be useful.
