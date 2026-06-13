#!/usr/bin/env node
/**
 * Test for context-budget-planner snip_tail_tool_results reason assignment.
 */

import assert from 'node:assert/strict';
import { planContextBudgetActions } from '../dist/core/index.js';

// Test that snip reason is 'warning_threshold' when in warning zone
{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 18_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  const snippAction = plan.actions.find((a) => a.kind === 'snip_tail_tool_results');
  assert.ok(snippAction, 'snip action must be present when in warning zone');
  assert.equal(snippAction.reason, 'warning_threshold', 'snip reason must be warning_threshold in warning zone');
}

// Test that snip reason is 'proactive_threshold' when in proactive zone
{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 35_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  const snippAction = plan.actions.find((a) => a.kind === 'snip_tail_tool_results');
  assert.ok(snippAction, 'snip action must be present when in proactive zone');
  assert.equal(snippAction.reason, 'proactive_threshold', 'snip reason must be proactive_threshold in proactive zone');
}

// Test that snip reason matches plan.reason for consistency
{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 35_000,
    effectiveContextWindowTokens: 50_000,
    isToolFollowUpRound: false,
    turn: 2,
  });
  assert.equal(plan.reason, 'proactive_threshold', 'plan reason should be proactive_threshold');
  const snippAction = plan.actions.find((a) => a.kind === 'snip_tail_tool_results');
  assert.equal(snippAction.reason, plan.reason, 'snip reason should match plan reason');
}

console.log('[PASS] context-budget-planner assigns correct snip reason');
