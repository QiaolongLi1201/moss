#!/usr/bin/env node
/**
 * Self-test for legacy DmossAgent adapter helpers.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-loop-adapter.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  MINI_AGENT_EVENT_VERSION,
  createDmossAgentLoopEventAdapter,
  createMiniAgentStream,
  createModelDefFromDmossConfig,
} from '../dist/core/index.js';

{
  const model = createModelDefFromDmossConfig({
    llmProvider: { id: 'fake-provider', displayName: 'Fake', complete: async () => null, stream: async () => null },
    model: 'fake-model',
    maxTokens: 1234,
    contextTokens: 5678,
  });

  assert.equal(model.id, 'fake-model');
  assert.equal(model.provider, 'fake-provider');
  assert.equal(model.maxTokens, 1234);
  assert.equal(model.contextWindow, 5678);
  assert.equal(model.reasoning, false);

  const thinkingHistoryModel = createModelDefFromDmossConfig({
    llmProvider: {
      id: 'fake-provider',
      displayName: 'Fake',
      complete: async () => null,
      stream: async () => null,
    },
    model: 'fake-model',
    roundTripAssistantThinking: true,
  });
  assert.equal(thinkingHistoryModel.reasoning, true);
}

{
  const adapter = createDmossAgentLoopEventAdapter();

  assert.deepEqual(adapter.onMiniEvent({ type: 'message_delta', delta: 'hello' }), [
    { type: 'text_delta', delta: 'hello' },
  ]);
  assert.deepEqual(
    adapter.onMiniEvent({ type: 'thinking_delta', delta: 'plan' }),
    [{ type: 'thinking_delta', delta: 'plan' }],
  );
  assert.deepEqual(
    adapter.onMiniEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'probe',
      args: { value: 1 },
    }),
    [{ type: 'tool_start', toolCallId: 'call-1', toolName: 'probe', input: { value: 1 } }],
  );
  assert.deepEqual(
    adapter.onMiniEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'probe',
      result: 'ok',
      isError: false,
    }),
    [
      {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'probe',
        result: 'ok',
        isError: false,
      },
    ],
  );
  assert.deepEqual(
    adapter.onMiniEvent({
      type: 'context_action',
      reason: 'baseline_hygiene',
      actions: [
        {
          kind: 'microcompact',
          reason: 'baseline_hygiene',
          count: 2,
          savedChars: 120,
          savedTokens: 30,
        },
      ],
      savedChars: 120,
      savedTokens: 30,
    }),
    [{ type: 'microcompact', compressedCount: 2, savedChars: 120, savedTokens: 30 }],
  );
  assert.deepEqual(
    adapter.onMiniEvent({
      type: 'llm_usage',
      inputTokens: 7,
      outputTokens: 11,
    }),
    [],
  );
  assert.deepEqual(
    adapter.onMiniEvent({
      type: 'turn_end',
      turn: 1,
      stopReason: 'length',
      totalToolCalls: 1,
    }),
    [{ type: 'turn_end', turn: 1, stopReason: 'max_tokens', totalToolCalls: 1 }],
  );

  const done = adapter.getDoneEvent({
    finalText: 'fallback',
    turns: 1,
    totalToolCalls: 1,
    messages: [],
  });
  assert.equal(done.type, 'done');
  assert.equal(done.result.response, 'hello');
  assert.equal(done.result.stopReason, 'max_tokens');
  assert.deepEqual(done.result.toolCalls, [{ id: 'call-1', name: 'probe', input: { value: 1 } }]);
  assert.deepEqual(done.result.toolResults, [{ toolUseId: 'call-1', content: 'ok', isError: false }]);
  assert.deepEqual(done.result.usage, { inputTokens: 7, outputTokens: 11 });
  assert.deepEqual(done.result.thinking, ['plan']);
}

{
  const adapter = createDmossAgentLoopEventAdapter();
  adapter.onMiniEvent({ type: 'message_delta', delta: 'legacy text' });
  assert.deepEqual(
    adapter.onMiniEvent({ type: 'turn_end', turn: 1, totalToolCalls: 0 }),
    [{ type: 'turn_end', turn: 1, stopReason: 'end_turn', totalToolCalls: 0 }],
  );
}

{
  const stream = createMiniAgentStream();
  stream.push({ type: 'turn_start', turn: 1 });
  stream.end({ finalText: '', turns: 1, totalToolCalls: 0, messages: [] });

  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(events.length, 1);
  assert.equal(events[0].version, MINI_AGENT_EVENT_VERSION);
}

console.log('[PASS] DmossAgent loop adapter maps MiniAgent events and versions streams');
