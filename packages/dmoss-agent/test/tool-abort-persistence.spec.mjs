#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildDeterministicCompactionSummary } from '../dist/context/deterministic-summary.js';
import { executeAgentLoopToolCalls } from '../dist/core/loop/agent-loop-tool-execution.js';
import { createToolLoopGuardState } from '../dist/core/tools/tool-loop-guard.js';

function makeTool(name, execute) {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: 'object', properties: {} },
    execute,
  };
}

async function runSingleToolRound({ tool, callId, abortSignalForTool, onEvent }) {
  const assistantContent = [
    {
      type: 'tool_use',
      id: callId,
      name: tool.name,
      input: {},
    },
  ];
  const currentMessages = [
    {
      role: 'assistant',
      content: assistantContent,
      timestamp: 1,
    },
  ];
  const persistedMessages = [];
  const events = [];
  const metrics = {
    totalToolCalls: 0,
    toolErrors: 0,
    consecutiveToolErrors: 0,
    toolCallsByName: {},
    prepNextTurnParallelMs: 0,
  };
  const runAbort = new AbortController();

  await executeAgentLoopToolCalls({
    sessionKey: 'abort-persistence-fixture',
    currentMessages,
    assistantContent,
    toolCalls: [{ id: callId, name: tool.name, input: {} }],
    resolveToolsForRun: () => [tool],
    toolCtx: {
      workspaceDir: '/tmp/dmoss-abort-persistence',
      sessionKey: 'abort-persistence-fixture',
    },
    abortSignal: runAbort.signal,
    toolTimeoutMs: 5_000,
    toolHeartbeatIntervalMs: 1_000,
    skipHeartbeatToolNames: new Set(),
    parallelSafeTools: new Set(),
    loadToolsMetaName: undefined,
    toolLoopGuard: createToolLoopGuardState(),
    metrics,
    evaluateSteering: () => [],
    appendMessage: async (_sessionKey, msg) => {
      persistedMessages.push(msg);
    },
    push: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    toolAbortSignalFor: abortSignalForTool
      ? (toolCallId) => (toolCallId === callId ? abortSignalForTool : undefined)
      : undefined,
  });

  assert.equal(persistedMessages.length, 1, 'tool round must persist exactly one user tool_result message');
  return { persisted: persistedMessages[0], events };
}

function firstToolResult(message) {
  assert(Array.isArray(message.content), 'persisted tool result message should use content blocks');
  const block = message.content.find((item) => item.type === 'tool_result');
  assert(block, 'persisted message should contain a tool_result block');
  return block;
}

{
  const toolAbort = new AbortController();
  const slowTool = makeTool('slow_probe', async (_input, ctx) => {
    if (ctx.abortSignal?.aborted) {
      return new Promise(() => {});
    }
    await new Promise((_resolve, _reject) => {
      ctx.abortSignal?.addEventListener('abort', () => {
        // The agent's abortable wrapper owns the cancellation outcome.
      }, { once: true });
    });
  });

  const { persisted, events } = await runSingleToolRound({
    tool: slowTool,
    callId: 'abort-call-1',
    abortSignalForTool: toolAbort.signal,
    onEvent: (event) => {
      if (event.type === 'tool_execution_start') {
        toolAbort.abort(new Error('cancel only this tool'));
      }
    },
  });

  const block = firstToolResult(persisted);
  assert.equal(block.is_error, true, 'aborted tool result should still be marked as error for providers');
  assert.deepEqual(block.aborted, { by: 'user' }, 'persisted tool_result must retain user abort marker');
  assert(
    events.some((event) => event.type === 'tool_execution_end' && event.aborted?.by === 'user'),
    'SSE/tool event should keep the same abort marker as persisted history',
  );
  const summary = buildDeterministicCompactionSummary([persisted], 'fixture');
  assert.match(summary, /tool_result slow_probe aborted:user:/, 'deterministic compaction summary must preserve abort-vs-failure semantics');
  assert.doesNotMatch(summary, /slow_probe aborted:user error/, 'user-aborted tool results should not be summarized as retryable errors');
}

{
  const failingTool = makeTool('plain_failure_probe', async () => {
    throw new Error('plain failure');
  });
  const { persisted } = await runSingleToolRound({
    tool: failingTool,
    callId: 'plain-failure-call-1',
  });

  const block = firstToolResult(persisted);
  assert.equal(block.is_error, true);
  assert.equal(block.aborted, undefined, 'plain tool failures must not be labelled as user aborts');
  const summary = buildDeterministicCompactionSummary([persisted], 'fixture');
  assert.match(summary, /tool_result plain_failure_probe error:/, 'plain failures should still be summarized as errors');
}

console.log('[tool-abort-persistence] PASS');
