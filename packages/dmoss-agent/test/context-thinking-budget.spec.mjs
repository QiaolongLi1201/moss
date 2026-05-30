#!/usr/bin/env node
/**
 * Regression: provider-native assistant thinking is part of the next prompt
 * for reasoning gateways, so context budgeting must count it.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/context-thinking-budget.spec.mjs
 */

import assert from 'node:assert/strict';

import {
  estimateMessageChars,
  estimateMessageTokens,
  estimatePromptUnitsForContextWindow,
  pruneContextMessages,
} from '../dist/context/index.js';
import {
  shouldIncludeThinkingInBudget,
} from '../dist/core/loop/agent-loop-context-prep.js';

const hiddenThinking = '推理'.repeat(6000);
const assistantWithThinking = {
  role: 'assistant',
  content: [{ type: 'text', text: 'visible answer' }],
  thinking: [hiddenThinking],
  timestamp: 2,
};

assert.ok(
  estimateMessageChars(assistantWithThinking) < hiddenThinking.length,
  'assistant thinking is UI-only unless the next provider payload round-trips it',
);
assert.ok(
  estimateMessageChars(assistantWithThinking, { includeThinking: true }) >= hiddenThinking.length,
  'assistant thinking must count toward message char estimates when providers round-trip it',
);
assert.equal(
  estimateMessageTokens(assistantWithThinking),
  estimateMessageTokens({ ...assistantWithThinking, thinking: [] }),
  'non-round-trip token estimates must not count replay-only thinking',
);
assert.ok(
  estimateMessageTokens(assistantWithThinking, { includeThinking: true }) >
    estimateMessageTokens({ ...assistantWithThinking, thinking: [] }, { includeThinking: true }),
  'round-trip token estimates must count assistant thinking',
);

assert.equal(
  shouldIncludeThinkingInBudget([assistantWithThinking], { reasoning: true }),
  true,
  'reasoning models round-trip assistant thinking into the next provider payload',
);
assert.equal(
  shouldIncludeThinkingInBudget([assistantWithThinking], { reasoning: false }),
  false,
  'non-reasoning models retain thinking only for UI replay',
);
assert.equal(
  shouldIncludeThinkingInBudget([
    assistantWithThinking,
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      timestamp: 4,
    },
  ], { reasoning: false }),
  true,
  'tool-result follow-up rounds still round-trip prior assistant thinking even while suppressing reasoning',
);

const promptUnitsWithoutRoundTrip = estimatePromptUnitsForContextWindow({
  messages: [
    { role: 'user', content: 'short question', timestamp: 1 },
    assistantWithThinking,
    { role: 'user', content: 'next question', timestamp: 3 },
  ],
  systemPrompt: '',
  charsPerTokenUnit: 1,
  effectiveContextWindowTokens: 8_000,
});

assert.ok(
  promptUnitsWithoutRoundTrip < 8_000,
  `UI-only thinking should not trigger context pressure; got ${promptUnitsWithoutRoundTrip}`,
);

const promptUnitsWithRoundTrip = estimatePromptUnitsForContextWindow({
  messages: [
    { role: 'user', content: 'short question', timestamp: 1 },
    assistantWithThinking,
    { role: 'user', content: 'next question', timestamp: 3 },
  ],
  systemPrompt: '',
  charsPerTokenUnit: 1,
  effectiveContextWindowTokens: 8_000,
  includeThinking: true,
});

assert.ok(
  promptUnitsWithRoundTrip > 8_000,
  `round-tripped hidden thinking should trigger context pressure; got ${promptUnitsWithRoundTrip}`,
);

const pruned = pruneContextMessages({
  messages: [
    { role: 'user', content: 'old question', timestamp: 1 },
    assistantWithThinking,
    { role: 'user', content: 'recent question', timestamp: 3 },
  ],
  contextWindowTokens: 8_000,
  systemPromptTokens: 0,
  charsPerTokenUnit: 1,
  includeThinking: true,
  settings: {
    maxHistoryShare: 0.25,
    keepLastAssistants: 0,
    softTrimRatio: 1,
    hardClearRatio: 1,
  },
});

assert.deepEqual(
  pruned.messages.map((message) => message.timestamp),
  [3],
  'message-drop pruning must see hidden thinking pressure and drop old assistant reasoning when the budget is tight',
);

const notPruned = pruneContextMessages({
  messages: [
    { role: 'user', content: 'old question', timestamp: 1 },
    assistantWithThinking,
    { role: 'user', content: 'recent question', timestamp: 3 },
  ],
  contextWindowTokens: 8_000,
  systemPromptTokens: 0,
  charsPerTokenUnit: 1,
  includeThinking: false,
  settings: {
    maxHistoryShare: 0.25,
    keepLastAssistants: 0,
    softTrimRatio: 1,
    hardClearRatio: 1,
  },
});

assert.deepEqual(
  notPruned.messages.map((message) => message.timestamp),
  [1, 2, 3],
  'non-round-trip thinking must not create spurious pruning pressure',
);

console.log('[PASS] context budgeting counts assistant thinking history');
