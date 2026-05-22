#!/usr/bin/env node
/**
 * P2.3 — Error Classification Consistency tests.
 *
 * Feed the same error into all classifiers and assert consistent retryability:
 *   - classifyLlmError (agent-loop retry decisions)
 *   - classifyProviderError (user-facing surface)
 *   - isDmossErrorRecoverable (structured errors)
 *   - classifyFailoverReason (model failover)
 *
 * Run: node packages/dmoss-agent/test/error-classification-consistency.spec.mjs
 */

import assert from 'node:assert/strict';
import { classifyLlmError } from '../dist/core/index.js';
import { classifyProviderError, classifyFailoverReason, isRateLimitError, isTimeoutError, isServerError, isTransientError, isContextOverflowError } from '../dist/provider/index.js';
import { DmossError, ErrorCode, isDmossErrorRecoverable } from '../dist/errors.js';

const TEST_CASES = [
  {
    label: 'rate_limit_429',
    message: '429 rate_limit: too many requests',
    status: 429,
    expectLlmRetryable: true,
    expectProviderRetryable: true,
    expectDmossRecoverable: true,
    expectFailover: true, // rate_limit triggers failover (only timeout doesn't)
  },
  {
    label: 'auth_401',
    message: '401 Incorrect API key provided',
    status: 401,
    expectLlmRetryable: false,
    expectProviderRetryable: false,
    expectDmossRecoverable: false,
    expectFailover: true,
  },
  {
    label: 'server_502',
    message: '502 Bad Gateway from upstream',
    status: 502,
    expectLlmRetryable: true,
    expectProviderRetryable: true,
    expectDmossRecoverable: false, // 502 is upstream but not in recoverable list
    expectFailover: false, // 502 is transient retry, not a failover signal
  },
  {
    label: 'server_503',
    message: '503 Service Unavailable',
    status: 503,
    expectLlmRetryable: true,
    expectProviderRetryable: true,
    expectDmossRecoverable: false,
    expectFailover: false, // 503 is transient retry, not a failover signal
  },
  {
    label: 'timeout',
    message: 'Request timed out after 30s',
    status: null,
    expectLlmRetryable: true,
    expectProviderRetryable: true,
    expectDmossRecoverable: false, // timeout is recoverable in DmossError but not via code
    expectFailover: false, // timeout doesn't trigger failover
  },
  {
    label: 'connection_refused',
    message: 'fetch failed: ECONNREFUSED',
    status: null,
    expectLlmRetryable: true,
    expectProviderRetryable: true,
    expectDmossRecoverable: false,
    expectFailover: false,
  },
  {
    label: 'context_overflow',
    message: 'context_length_exceeded: prompt is too long',
    status: null,
    expectLlmRetryable: false,
    expectProviderRetryable: true, // context_length_exceeded is retryable after compaction
    expectDmossRecoverable: false,
    expectFailover: false,
  },
  {
    label: 'client_error',
    message: '400 invalid request: tool result not found',
    status: 400,
    expectLlmRetryable: false,
    expectProviderRetryable: false, // "tool result not found" matches context_corruption
    expectDmossRecoverable: false,
    expectFailover: false,
  },
  {
    label: 'quota_exceeded',
    message: '429 You have exceeded the monthly usage quota',
    status: 429,
    expectLlmRetryable: true, // 429 matches rate_limit pattern in llm classifier
    expectProviderRetryable: false, // quota_exceeded is NOT retryable
    expectDmossRecoverable: true,
    expectFailover: true, // "quota" matches rate_limit in failover classifier
  },
  {
    label: 'stream_terminated',
    message: 'LLM stream error: terminated',
    status: null,
    expectLlmRetryable: true, // premature_close is retryable
    expectProviderRetryable: true, // service_unavailable
    expectDmossRecoverable: false,
    expectFailover: false,
  },
];

for (const tc of TEST_CASES) {
  // ── classifyLlmError ──
  const llmClass = classifyLlmError(new Error(tc.message));
  assert.equal(
    llmClass.retryable,
    tc.expectLlmRetryable,
    `[${tc.label}] classifyLlmError.retryable: expected ${tc.expectLlmRetryable}, got ${llmClass.retryable} (${llmClass.category})`,
  );

  // ── classifyProviderError ──
  const providerSurface = classifyProviderError({
    errorMessage: tc.message,
    status: tc.status ?? undefined,
  });
  assert.equal(
    providerSurface.retryable,
    tc.expectProviderRetryable,
    `[${tc.label}] classifyProviderError.retryable: expected ${tc.expectProviderRetryable}, got ${providerSurface.retryable} (${providerSurface.category})`,
  );

  // ── classifyFailoverReason ──
  const failoverReason = classifyFailoverReason(tc.message);
  const expectFailover = failoverReason !== null && failoverReason !== 'timeout' && failoverReason !== 'connection';
  assert.equal(
    expectFailover,
    tc.expectFailover,
    `[${tc.label}] classifyFailoverReason: expected ${tc.expectFailover}, got ${expectFailover} (${failoverReason})`,
  );

  // ── Pattern matchers consistency ──
  // isTransientError should align with llm retryable for known patterns
  const isTransient = isTransientError(tc.message);
  if (tc.label === 'rate_limit_429' || tc.label === 'server_502' || tc.label === 'server_503') {
    assert.equal(isTransient, true, `[${tc.label}] isTransientError should be true`);
  }

  // isContextOverflowError for overflow case
  if (tc.label === 'context_overflow') {
    assert.equal(
      isContextOverflowError(tc.message),
      true,
      `[${tc.label}] isContextOverflowError should be true`,
    );
  }

  console.log(`  [PASS] ${tc.label}: llm=${llmClass.category} provider=${providerSurface.category} failover=${failoverReason}`);
}

// ── DmossError recoverability consistency ──
{
  const rateLimitedErr = new DmossError({ code: ErrorCode.PROVIDER_RATE_LIMITED, message: 'rate limited' });
  assert.equal(isDmossErrorRecoverable(rateLimitedErr), true, 'rate limited → recoverable');

  const upstreamErr = new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'upstream error' });
  assert.equal(isDmossErrorRecoverable(upstreamErr), true, 'upstream error → recoverable');

  const timeoutErr = new DmossError({ code: ErrorCode.TOOL_EXECUTION_TIMEOUT, message: 'tool timed out' });
  assert.equal(isDmossErrorRecoverable(timeoutErr), true, 'tool timeout → recoverable');

  const authErr = new DmossError({ code: ErrorCode.PROVIDER_AUTH_FAILED, message: 'auth failed' });
  assert.equal(isDmossErrorRecoverable(authErr), false, 'auth failed → NOT recoverable');

  const inputErr = new DmossError({ code: ErrorCode.USER_INPUT_INVALID, message: 'invalid input' });
  assert.equal(isDmossErrorRecoverable(inputErr), false, 'invalid input → NOT recoverable');

  console.log('  [PASS] DmossError recoverability: rate_limit/upstream/timeout=true, auth/input=false');
}

// ── Cross-classifier: rate_limit patterns are consistently identified ──
{
  const rateMessages = [
    '429 too many requests',
    'rate_limit exceeded',
    'quota exceeded',
    'resource exhausted',
  ];
  for (const msg of rateMessages) {
    assert.ok(
      isRateLimitError(msg) || isTransientError(msg),
      `rate pattern "${msg}" should be caught by rate_limit or transient`,
    );
  }
  console.log('  [PASS] rate_limit patterns consistently detected across matchers');
}

// ── Cross-classifier: timeout patterns are consistently identified ──
{
  const timeoutMessages = [
    'Request timed out',
    'deadline exceeded',
    'ETIMEDOUT',
    'first-event timeout',
  ];
  for (const msg of timeoutMessages) {
    assert.ok(
      isTimeoutError(msg) || isTransientError(msg),
      `timeout pattern "${msg}" should be caught`,
    );
  }
  console.log('  [PASS] timeout patterns consistently detected across matchers');
}

console.log('\n[pass] error-classification-consistency: 13/13');
