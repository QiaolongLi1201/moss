#!/usr/bin/env node
/**
 * Self-test for ContextBudgetPlanner.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/context-budget-planner.spec.mjs
 */

import assert from 'node:assert/strict';
import { planContextBudgetActions } from '../dist/core/index.js';
import { runPerTurnContextManagement } from '../dist/core/loop/per-turn-context-management.js';
import {
  assessPromptCacheEligibility,
  checkPromptPrefixStable,
  snapshotMessagesForPrefixCheck,
} from '../dist/core/llm/prompt-prefix-cache.js';

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 35_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 1,
  });
  assert.equal(plan.reason, 'first_turn');
  assert.deepEqual(plan.actions, []);
}

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 35_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: true,
    turn: 2,
  });
  assert.equal(plan.reason, 'tool_followup_round');
  assert.deepEqual(plan.actions, [{ kind: 'invalidate_stale_reads', reason: 'tool_followup_round' }]);
}

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 1_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  assert.equal(plan.reason, 'baseline_hygiene');
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ['invalidate_stale_reads'],
  );
}

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 18_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  assert.equal(plan.reason, 'warning_threshold');
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ['invalidate_stale_reads', 'snip_tail_tool_results', 'microcompact'],
  );
  assert.deepEqual(plan.actions.at(-1).microcompactConfig, {
    keepRecentResults: 4,
    minContentLength: 100,
  });
}

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 35_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  assert.equal(plan.reason, 'proactive_threshold');
  assert.deepEqual(plan.actions.at(-1).microcompactConfig, {
    keepRecentResults: 2,
    minContentLength: 50,
  });
}

{
  const messages = Array.from({ length: 7 }, (_, i) => ({
    role: 'user',
    timestamp: Date.now() + i,
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tool-${i}`,
        name: 'read',
        content: `large-result-${i}: ${'x'.repeat(260)}`,
      },
    ],
  }));
  const events = [];
  const result = runPerTurnContextManagement({
    currentMessages: messages,
    estPromptTokens: 1_000,
    effectiveContextWindowTokens: 50_000,
    pendingToolResultFollowUp: false,
    turns: 2,
    push: (event) => events.push(event),
  });

  assert.equal(result.savedChars, 0);
  assert.equal(events.length, 0, 'low-pressure context hygiene must not compact active history');
}

{
  const previous = snapshotMessagesForPrefixCheck([
    { role: 'user', content: 'hello', timestamp: 1 },
  ]);
  assert.equal(
    checkPromptPrefixStable(previous, [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
    ]),
    null,
  );
  // Enhanced check now classifies the change kind (content_modified for non-role changes)
  // and includes a human-readable detail string.
  const issue = checkPromptPrefixStable(previous, [
    { role: 'user', content: 'changed', timestamp: 1 },
  ]);
  assert.ok(issue, 'changed content should be detected');
  assert.equal(issue.previousLength, 1);
  assert.equal(issue.currentLength, 1);
  assert.equal(issue.firstChangedIndex, 0);
  assert.ok(
    issue.kind === 'content_modified' || issue.kind === 'changed',
    `unexpected kind: ${issue.kind}`,
  );
  assert.ok(typeof issue.detail === 'string' && issue.detail.length > 0, 'detail must be populated');
}

{
  assert.deepEqual(
    assessPromptCacheEligibility(undefined, { enabled: false }),
    {
      eligible: false,
      reason: 'disabled',
      stableChars: 0,
      dynamicChars: 0,
      minStableChars: 2048,
      maxDynamicCharsRatio: 0.25,
    },
  );
  assert.equal(
    assessPromptCacheEligibility({ stable: 'short', dynamic: '' }).reason,
    'stable_prefix_too_short',
  );
  assert.equal(
    assessPromptCacheEligibility({
      stable: 's'.repeat(4096),
      dynamic: 'd'.repeat(2048),
    }).reason,
    'dynamic_suffix_too_large',
  );
  const eligible = assessPromptCacheEligibility({
    stable: 's'.repeat(4096),
    dynamic: 'd'.repeat(128),
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.reason, 'eligible');
}

console.log('[PASS] ContextBudgetPlanner returns stable action plans');
