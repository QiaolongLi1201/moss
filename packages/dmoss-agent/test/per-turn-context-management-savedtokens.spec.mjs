#!/usr/bin/env node
/**
 * Test for per-turn-context-management consistent savedTokens return.
 */

import assert from 'node:assert/strict';
import { runPerTurnContextManagement } from '../dist/core/loop/per-turn-context-management.js';

// Test that savedTokens is always returned (even if 0)
{
  const result = runPerTurnContextManagement({
    currentMessages: [],
    estPromptTokens: 1000,
    effectiveContextWindowTokens: 50000,
    pendingToolResultFollowUp: false,
    turns: 1,
    push: () => {},
  });
  assert.ok('savedTokens' in result, 'savedTokens must be in return value');
  assert.equal(result.savedTokens, 0, 'early return on turn 1 should have savedTokens: 0');
}

// Test that savedTokens is returned on turn > 1 with no actions
{
  const result = runPerTurnContextManagement({
    currentMessages: [
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
    ],
    estPromptTokens: 100,
    effectiveContextWindowTokens: 50000,
    pendingToolResultFollowUp: false,
    turns: 2,
    push: () => {},
  });
  assert.ok('savedTokens' in result, 'savedTokens must be in return value when no actions');
  assert.equal(result.savedTokens, 0, 'no actions should result in savedTokens: 0');
}

console.log('[PASS] per-turn-context-management returns savedTokens consistently');
