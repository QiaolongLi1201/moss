# Moss Quality Audit Session Summary

Date: 2026-05-28

Scope: primarily `@dmoss/agent`, with final root workspace verification across `moss`.

Method: evidence-first architecture review with Claude as planner/reviewer and Codex/Qwen as implementer/reviewer. Findings were accepted only when tied to source behavior, a concrete failure mode, and a regression test or targeted verification.

## What Was Audited

The audit focused on agent-loop reliability, provider stream correctness, tool execution contracts, cancellation and timeout behavior, context overflow handling, web fetch security, session persistence, extension isolation, MCP behavior, package metadata, and user-visible stream semantics. Final root verification also covered dependent workspace packages and exposed one `@dmoss/memory` async write lifecycle bug.

The review deliberately avoided feature-checklist comparisons against agent frameworks. The standard was whether current code could silently produce wrong behavior, violate a declared contract, lose user state, leak unsafe tool behavior, or create confusing failure modes in robotics-agent usage.

## What Was Fixed

- `f02c07e` - Hardened spawn/process safety, sanitizer coverage, memory lifecycle, and follow-up guard wiring. Bug class: safety/reliability. Impact: reduced risk of unsafe local tool execution and prompt/tool follow-up drift.
- `3625ea1` - Closed P0 extension singleton and streaming capability gaps. Bug class: instance isolation/contract violation. Impact: separate agent instances no longer shared extension state unexpectedly.
- `5bc3559` - Fixed structured content pipeline gaps, regex issues, embedding data loss, and test quality issues. Bug class: data integrity/contract violation. Impact: tool outputs and memory data survive conversion paths more reliably.
- `6e98cc7` - Fixed channel hang, MCP abort signal propagation, DNS rebinding, and atomic writes. Bug class: async lifecycle/security/data durability. Impact: fewer hung calls, better cancellation, safer fetch preflight, safer writes.
- `711027c` - Cleaned remaining type-safety, error-handling, and duplicated-code debt. Bug class: maintainability with correctness risk. Impact: smaller surface for future regressions.
- `e663464` - Resolved round-5 security, correctness, and reliability findings. Bug class: mixed correctness/security. Impact: hardened broad agent behavior uncovered by the audit.
- `a768da3`, `955b1b3`, `eb7e629`, `f633344` - Hardened OpenAI/Anthropic/provider stream parsing and incomplete stream handling. Bug class: provider contract violation. Impact: malformed or incomplete streams fail explicitly instead of becoming false-success responses.
- `87d3b81` - Hardened JSONL session persistence. Bug class: data integrity/concurrency. Impact: session writes are more durable and replay-safe.
- `9a9b737`, `ade1927` - Preserved loop stop reasons/usage and rejected invalid chat stream termination. Bug class: public API contract. Impact: callers get accurate final state instead of ambiguous success.
- `9f12cf8`, `1d65d43`, `71e6ac3`, `76cec46` - Preserved structured tool content, classified tool watchdog timeouts, avoided duplicate structured text, and added contract snapshots. Bug class: tool-result contract. Impact: structured outputs stay usable without duplicated text or wrong abort labels.
- `18bd9b8`, `84150c6` - Isolated extension registries and exposed documented root exports. Bug class: discoverability/isolation. Impact: package surface and instance behavior better match documented use.
- `3276232`, `794b321`, `6e43908` - Hardened MCP tool bridge, cancellation, and malformed stdout handling. Bug class: external process protocol/lifecycle. Impact: MCP calls fail and cancel predictably.
- `68ef6fe`, `2778f63` - Pinned HTTPS DNS for `web_fetch` and preserved provider `Retry-After` hints. Bug class: SSRF/transport contract. Impact: safer web fetch and better rate-limit behavior.
- `1e4acb6` - Closed final runtime-contract issues: `web_fetch` declares `undici` as a runtime dependency, tool heartbeat watchdog respects `toolTimeoutMs`, `DmossAgent.chat()` drains error streams while preserving the first error, and tool approval denial reasons propagate into `tool_result`. Bug class: package contract/timeout contract/lifecycle/declared contract. Impact: published installs, long-running robotics tools, fatal-run checkpoints, and denied-tool UX now match runtime expectations.
- `0180bb6` - Awaited `@dmoss/memory` search access-metadata writes before returning. Bug class: async lifecycle/data durability. Impact: `search()` no longer resolves while an `index.json` write is still pending, which also removes the temp-directory cleanup race that root verification exposed.

## Investigated And Rejected

- Cancellation propagation to in-flight tools: rejected as a current bug. The chain from agent loop to `executeOneToolCall` to `ctx.abortSignal` reaches `runProcess`, Docker exec, and `web_fetch`; cancellation tests cover process killing and bridge behavior.
- Context-window overflow infinite retry: rejected. Provider overflow is detected via `isContextOverflowError`, handled by `runOverflowRecovery`, and classified as non-retryable by the generic loop classifier to avoid billing loops.
- Re-opening already-landed provider SSE, JSONL, MCP cancellation, structured tool text, DNS pinning, and `Retry-After` areas without new evidence: rejected as low-value fishing. Recent regression tests now cover those contracts.

## Regression Protection

- `npm test --workspace=@dmoss/agent` currently runs 69 spec files.
- `npm test --workspace=@dmoss/memory` covers the access-metadata persistence contract that failed before `0180bb6`.
- Root `npm run verify` now passes: boundary checks, hygiene checks, build, typecheck, lint, and workspace test suites.
- Contract/snapshot coverage exists for LLM error routing, root export surface, structured tool result shape, provider parsing, message conversion round trips, cancellation, session persistence, overflow recovery, MCP behavior, and web fetch security.
- `1e4acb6` added or extended tests for heartbeat-vs-timeout behavior, `web_fetch` package metadata, `chat()` error draining and first-error precedence, approval denial reason propagation, and blank denial fallback.

## Known Gaps Not Addressed

- Performance profiling was not part of this audit. Real performance claims need runtime profiling, not source inspection.
- UI/product workflow usability was not deeply reviewed here; this audit centered on `moss` runtime contracts and package-level verification.
- The heartbeat formula intentionally makes `heartbeatIntervalMs > toolTimeoutMs` resolve to one missed heartbeat. This is defensible for fast-timeout tools, but a short code comment could make the intent clearer.
- The audit did not attempt to prove there are no bugs anywhere. It closed the evidence-supported hypotheses that surfaced during multi-agent review.

## Recommendation

The audit has reached a natural convergence point for the reviewed `moss` runtime surface: the planned H1/H2/H3 checks are closed, recent fixes are verified, root `npm run verify` passes, and both Claude and Qwen returned `READY` on the current direction.

Recommended next step: review the summary, then treat the quality audit as converged unless a new user report, profiler result, or concrete product workflow exposes a fresh issue. Further open-ended bug fishing is likely to produce lower-signal changes than targeted feature work, profiling, or UI/workflow review.
