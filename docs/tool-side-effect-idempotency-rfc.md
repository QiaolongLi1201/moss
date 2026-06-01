# RFC: In-flight Deduplication for Non-idempotent Tools

Status: draft for review before runtime changes

## Problem

Moss already avoids replaying readonly tool results during LLM stream retry, but
there is a separate risk after a mutating tool is aborted or returns an error:
the next model turn can issue the same command again while the original side
effect is still in flight. For device tools such as `device_exec`, that can
duplicate writes, service restarts, installs, or actuation commands.

## Proposed Contract

Add an optional field to `ToolMetadata`:

```ts
idempotent?: boolean;
```

Semantics:

- `idempotent === false`: the tool may cause non-repeatable side effects. Moss
  should deduplicate identical in-flight calls for this tool.
- `idempotent === true`: the tool is safe to repeat. Moss should not deduplicate
  it; normal retry/replay rules still apply.
- `idempotent === undefined`: no in-flight deduplication. This keeps the rollout
  conservative and avoids silently changing host-defined tools.

Dedup key:

```ts
`${toolName}|${stableSerializeNormalizedInput(input)}`
```

The key must be computed after schema validation and tool `normalizeInput`, so
equivalent inputs converge before matching. Different `toolCallId` values must
not bypass the dedup key for `idempotent === false`; they should await the same
in-flight promise and receive the same result.

## Initial Built-in Classification

Readonly tools keep `idempotent` unset because they are already handled by
readonly replay policy and do not need this guard:

- `read_file`
- `list_directory`
- `search_files`
- `search_code`
- `web_fetch`
- `device_info`
- `device_file_read`
- `device_file_list`
- `device_temperature`
- `device_resources`
- `device_processes`
- `device_network`
- `device_cameras`
- ROS2 read tools such as `ros2_topic_list`, `ros2_node_list`, `ros2_pkg_list`

Mark these built-ins as `idempotent: false`:

- `exec`
- `device_exec`
- `device_file_write`
- `device_file_delete`
- `ros2_service_call`
- `ros2_launch`
- `create_subagent`
- memory write/delete tools

Host tools should opt in explicitly. Product hosts should classify board/backend
mutation tools as `idempotent: false` before enabling the runtime guard for
those tools.

## Proposed Runtime Hook Point

Implement in `packages/dmoss-agent/src/core/tools/tool-pipeline.ts` or a small
adjacent module used by `executeOneToolCall`:

1. Resolve and normalize the tool input.
2. If `tool.metadata?.idempotent !== false`, execute normally.
3. If false, look up `dedupKey` in an in-flight map.
4. If present, await the stored promise and return its outcome.
5. If absent, store the execution promise, remove it in `finally`, and return
   the outcome.

The map must be scoped to an agent/run or explicit execution context, not a
process-wide singleton, so unrelated `DmossAgent` instances do not block each
other.

## Required Tests Before Implementation

1. `device_exec` with identical normalized command while first call is pending:
   second call awaits the first and tool execute runs once.
2. Same tool with different normalized input: both calls run independently.
3. Same input after first promise settles: call executes again, proving the map
   is in-flight only.
4. A readonly tool with identical input still runs through existing readonly
   replay policy; the new guard does not change it.

## Open Questions

- Whether hosts need a custom `dedupKey(input)` metadata callback for tools with
  volatile but irrelevant fields such as `timeout_ms`.
- Whether a deduplicated second call should emit its own `tool_execution_start`
  / `tool_execution_end` events or reuse the first call's result silently.
- Whether dedup should be per run, per session, or per agent. The safest initial
  scope is per run.
