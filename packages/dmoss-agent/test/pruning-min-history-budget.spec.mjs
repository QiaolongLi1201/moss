#!/usr/bin/env node
/**
 * Regression: systemPromptTokens 远超 contextWindow + charsPerTokenUnit=1
 * 时不应把对话历史剪到「几乎只剩当前一条」。
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/pruning-min-history-budget.spec.mjs
 */

import assert from 'node:assert/strict';

import { pruneContextMessages } from '../dist/context/pruning.js';
import { createCompactionSummaryMessage } from '../dist/core/session/session-jsonl.js';

/** @param {'user'|'assistant'} role */
const msg = (role, n) => ({ role, content: 'あ'.repeat(n) });

const msgs = [
  msg('user', 80),
  msg('assistant', 400),
  msg('user', 80),
  msg('assistant', 400),
  msg('user', 80),
  msg('assistant', 400),
];

const r = pruneContextMessages({
  messages: msgs,
  contextWindowTokens: 16_384,
  /** 故意高估，模拟超长 system + 保守 token 估计 */
  systemPromptTokens: 500_000,
  charsPerTokenUnit: 1,
  settings: { maxHistoryShare: 0.5 },
});

assert.ok(
  r.budgetChars >= 512,
  `expected non-trivial budgetChars, got ${r.budgetChars}`,
);
assert.ok(r.messages.length >= 2, `expected >=2 messages kept, got ${r.messages.length}`);
assert.ok(r.keptChars >= 200, `expected keptChars>=200, got ${r.keptChars}`);

console.log('  [PASS] pruneContextMessages reserves min history when system estimate overshoots');

const toolUse = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'call_keep_parent', name: 'read', input: { path: '/tmp/a' } }],
};
const toolResult = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'call_keep_parent', name: 'read', content: 'x'.repeat(320) }],
};
const pair = pruneContextMessages({
  messages: [
    msg('user', 400),
    toolUse,
    msg('assistant', 900),
    msg('user', 900),
    toolResult,
  ],
  contextWindowTokens: 1024,
  systemPromptTokens: 0,
  charsPerTokenUnit: 1,
  settings: {
    maxHistoryShare: 0.25,
    keepLastAssistants: 0,
    softTrimRatio: 1,
    hardClearRatio: 1,
  },
});

assert.ok(pair.messages.includes(toolResult), 'expected recent tool_result to stay in pruned window');
assert.ok(
  pair.messages.includes(toolUse),
  'expected pruning to keep parent assistant tool_use for retained tool_result',
);

console.log('  [PASS] pruneContextMessages keeps tool_use parent for retained tool_result');

const summaryMessage = createCompactionSummaryMessage(
  'critical compacted fact: user said never drop calibration path /opt/rdk/calib.yaml',
  Date.now(),
);
const protectedSummary = pruneContextMessages({
  messages: [
    summaryMessage,
    msg('user', 3000),
    msg('assistant', 3000),
    msg('user', 3000),
    msg('assistant', 3000),
    msg('user', 80),
  ],
  contextWindowTokens: 2048,
  systemPromptTokens: 0,
  charsPerTokenUnit: 1,
  settings: {
    maxHistoryShare: 0.25,
    keepLastAssistants: 1,
    softTrimRatio: 1,
    hardClearRatio: 1,
  },
});

assert.ok(
  protectedSummary.messages.includes(summaryMessage),
  'expected latest compaction summary to survive message-drop pruning',
);
assert.ok(
  !protectedSummary.droppedMessages.includes(summaryMessage),
  'compaction summary must not be reported as dropped',
);

console.log('  [PASS] pruneContextMessages protects latest compaction summary');
