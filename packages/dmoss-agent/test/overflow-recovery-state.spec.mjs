#!/usr/bin/env node
/**
 * Self-test for overflow recovery state transitions.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/overflow-recovery-state.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  createOverflowRecoveryState,
  runOverflowRecovery,
} from '../dist/core/loop/overflow-recovery.js';

const message = (content, timestamp = Date.now()) => ({
  role: 'user',
  content,
  timestamp,
});

const plainMessages = (count) =>
  Array.from({ length: count }, (_, i) => message(`plain-${i}`, i + 1));

const toolResultMessages = (count) =>
  Array.from({ length: count }, (_, i) =>
    message(
      [
        {
          type: 'tool_result',
          tool_use_id: `tool-${i}`,
          name: 'read',
          content: `large-result-${i}: ${'x'.repeat(140)}`,
        },
      ],
      i + 1,
    ),
  );

const baseParams = (overrides) => ({
  errorText: 'context overflow',
  sessionKey: 'test-session',
  runId: 'test-run',
  prepareCompaction: async () => {
    throw new Error('prepareCompaction should not be called');
  },
  push: () => {},
  ...overrides,
});

{
  const state = createOverflowRecoveryState();
  assert.equal(state.recovery.kind, 'idle');
  assert.equal(state.level, 0);
  assert.equal(state.llmCompactionFailureStreak, 0);
  assert.equal(state.skipLlmCompactionOnOverflow, false);
}

{
  const state = createOverflowRecoveryState();
  const events = [];
  const messages = toolResultMessages(4);
  const outcome = await runOverflowRecovery(
    baseParams({
      state,
      currentMessages: messages,
      push: (event) => events.push(event),
    }),
  );

  assert.equal(outcome.kind, 'retry-same-turn');
  assert.equal(state.recovery.kind, 'cheap');
  assert.equal(state.level, 1);
  assert.equal(state.overflowRecoveries, 1);
  assert(events.some((event) => event.type === 'context_action'));
  assert(events.some((event) => event.recoveryLevel === 1));
}

{
  const state = createOverflowRecoveryState();
  const summaryMessage = message('summary', 100);
  const outcome = await runOverflowRecovery(
    baseParams({
      state,
      currentMessages: plainMessages(3),
      prepareCompaction: async () => ({
        summary: 'summary',
        summaryMessage,
      }),
    }),
  );

  assert.equal(outcome.kind, 'retry-same-turn');
  assert.equal(outcome.replacedSummaryMessage, summaryMessage);
  assert.equal(state.recovery.kind, 'idle');
  assert.equal(state.level, 0);
  assert.equal(state.contextCompactions, 1);
  assert.equal(state.llmCompactionFailureStreak, 0);
}

{
  const state = createOverflowRecoveryState();
  state.recovery = {
    kind: 'cheap',
    level: 1,
    llmCompactionFailureStreak: 0,
    llmSummarize: 'available',
  };
  const events = [];
  const messages = plainMessages(8);
  const outcome = await runOverflowRecovery(
    baseParams({
      state,
      currentMessages: messages,
      prepareCompaction: async () => {
        throw new Error('summary failed once');
      },
      push: (event) => events.push(event),
    }),
  );

  assert.equal(outcome.kind, 'retry-same-turn');
  assert.equal(state.recovery.kind, 'truncate');
  assert.equal(state.level, 3);
  assert.equal(state.llmCompactionFailureStreak, 1);
  assert.equal(state.skipLlmCompactionOnOverflow, false);
  assert.equal(messages.length, 6);
  assert(events.some((event) => event.recoveryLevel === 2));
  assert(
    events.some(
      (event) =>
        event.type === 'context_action' &&
        event.actions.some((action) => action.kind === 'emergency_truncate'),
    ),
  );
}

{
  const state = createOverflowRecoveryState();
  state.recovery = {
    kind: 'cheap',
    level: 1,
    llmCompactionFailureStreak: 1,
    llmSummarize: 'available',
  };
  const events = [];
  const messages = plainMessages(8);
  const outcome = await runOverflowRecovery(
    baseParams({
      state,
      currentMessages: messages,
      prepareCompaction: async () => {
        throw new Error('summary failed twice');
      },
      push: (event) => events.push(event),
    }),
  );

  assert.equal(outcome.kind, 'retry-same-turn');
  assert.equal(state.recovery.kind, 'fused');
  assert.equal(state.level, 3);
  assert.equal(state.llmCompactionFailureStreak, 2);
  assert.equal(state.skipLlmCompactionOnOverflow, true);
  assert(
    events.some(
      (event) =>
        event.type === 'context_action' &&
        event.actions.some((action) => action.kind === 'compaction_fuse'),
    ),
  );

  const retryEvents = [];
  const retryOutcome = await runOverflowRecovery(
    baseParams({
      state,
      currentMessages: messages,
      push: (event) => retryEvents.push(event),
    }),
  );
  assert.equal(retryOutcome.kind, 'rethrow');
  assert.deepEqual(retryEvents, []);
}

console.log('[PASS] Overflow recovery state transitions are explicit');
