# D-Moss Tool Runtime

The tool runtime is framework-owned; hosts provide tools and approval policy, but the agent loop keeps the execution order and guards consistent.

## Pipeline

```text
LLM tool_use
  -> load tools for this run
  -> validate input object
  -> host approval
  -> pre-tool hooks
  -> execute with timeout / abort signal
  -> post-tool hooks
  -> write tool_result
  -> roundtrip guard
  -> loop guard
  -> next LLM turn
```

## Responsibilities

| Stage | Module | Required | Owner |
| --- | --- | --- | --- |
| Tool declaration / lookup | `core/tools/tool-registry.ts` | Yes | Framework |
| Input object validation | `core/tools/tool-pipeline.ts` | Yes | Framework |
| Approval decision | `AgentLoopParams.checkToolApproval` / host hooks | Host-dependent | Host |
| Pre/post policy hooks | `core/tools/tool-hooks.ts` | Optional | Framework + host |
| Execution, timeout, abort | `core/tools/execute-tool-call.ts` and `core/loop/agent-loop-tool-execution.ts` | Yes | Framework |
| Tool result repair | `core/tools/tool-result-roundtrip-guard.ts` | Yes | Framework |
| Open URL / web fetch suppression | `core/tools/open-url-web-fetch-guard.ts` | Optional | Framework |
| Idempotent replay | `core/tools/tool-idempotent-replay.ts` | Optional | Framework |
| Same-turn loop limits | `core/tools/tool-loop-guard.ts` | Yes | Framework |

## Host Integration Rules

- Register durable tools through `ToolRegistry`; pass per-turn tools as `ephemeralTools`.
- Use `checkToolApproval` for host policy. Return `null` to let the framework continue with the default path.
- Use `ToolHookRegistry` for reusable policy, timing, sanitization, read-only enforcement, and post-failure hints.
- Mark read-only tools in `AgentLoopPlatformConfig.parallelSafeTools` only when concurrent execution cannot mutate shared state.
- If a host cancels a specific tool, provide `toolAbortSignalFor(toolCallId)` rather than aborting the whole run.

## Guard Limits

Tool loop limits are resolved once per attempted tool call and default to conservative values:

| Env | Default | Meaning |
| --- | ---: | --- |
| `DMOSS_TOOL_LOOP_IDENTICAL_LIMIT` | `2` | Maximum repeated calls with the same tool name and identical input in one user turn. |
| `DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT` | `24` | Maximum calls to one tool name in one user turn. |
| `DMOSS_TOOL_LOOP_TOTAL_LIMIT` | `64` | Maximum total tool calls in one user turn. |

Set these only for controlled debugging or known high-volume tool plans. Invalid, empty, or non-positive values fall back to defaults.
