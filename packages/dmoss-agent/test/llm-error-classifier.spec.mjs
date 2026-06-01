#!/usr/bin/env node
/**
 * Self-test for LLM error classification used by runAgentLoop retry decisions.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/llm-error-classifier.spec.mjs
 */

import assert from 'node:assert/strict';
import { classifyLlmError, retryDelayForLlmError } from '../dist/core/index.js';

function category(message) {
  return classifyLlmError(new Error(message)).category;
}

{
  // Rate limit: exponential backoff with a 2.5s base, doubling each attempt.
  const c = classifyLlmError(new Error('429 rate_limit: too many requests'));
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryable, true);
  assert.equal(retryDelayForLlmError(c, 1), 2_500);
  assert.equal(retryDelayForLlmError(c, 2), 5_000);
  assert.equal(retryDelayForLlmError(c, 3), 10_000);
}

{
  // Server-suggested retry-after parsed from error message.
  const c = classifyLlmError(new Error('429 rate_limit: please try again in 1.5s'));
  assert.equal(c.category, 'rate_limit');
  assert.equal(retryDelayForLlmError(c, 1), 1_500);
}

{
  // Server errors also get exponential backoff with shorter base.
  const c = classifyLlmError(new Error('502 Bad Gateway from upstream'));
  assert.equal(c.category, 'server_error');
  assert.equal(c.retryable, true);
  assert.equal(retryDelayForLlmError(c, 1), 1_000);
  assert.equal(retryDelayForLlmError(c, 2), 2_000);
}

{
  // Connection errors get the same transient backoff family.
  const c = classifyLlmError(new Error('fetch failed: ECONNRESET'));
  assert.equal(c.category, 'connection');
  assert.equal(retryDelayForLlmError(c, 1), 1_000);
}

{
  // Non-retryable categories return undefined (caller decides).
  const c = classifyLlmError(new Error('400 invalid request: tool result not found'));
  assert.equal(c.category, 'client_error');
  assert.equal(retryDelayForLlmError(c, 1), undefined);
}

{
  assert.equal(category('ERR_STREAM_PREMATURE_CLOSE'), 'premature_close');
  assert.equal(category('LLM stream error: terminated'), 'premature_close');
  assert.equal(category('context_length_exceeded: prompt is too long'), 'context_overflow');
  assert.equal(category('max_tokens is too large; must be <= 8192'), 'max_tokens');
  assert.equal(category('400 invalid request: tool result not found'), 'client_error');
  assert.equal(category('fetch failed: ECONNRESET'), 'connection');
  assert.equal(category('LLM produced no streaming output within 30s'), 'timeout');
}

console.log('[PASS] LLM error classifier returns stable categories');
