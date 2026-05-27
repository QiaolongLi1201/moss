#!/usr/bin/env node
/**
 * Snapshot backstop for provider stream-error routing.
 */

import assert from 'node:assert/strict';
import { classifyLlmError } from '../dist/core/index.js';

const cases = {
  anthropic_overloaded: 'Anthropic stream error overloaded_error: Overloaded',
  anthropic_rate_limit: 'Anthropic stream error rate_limit_error: Rate limited',
  anthropic_invalid_request: 'Anthropic stream error invalid_request_error: Invalid request: bad tool schema',
  anthropic_authentication: 'Anthropic stream error authentication_error: invalid x-api-key',
};

const snapshot = Object.fromEntries(
  Object.entries(cases).map(([name, message]) => {
    const classified = classifyLlmError(new Error(message));
    return [name, {
      category: classified.category,
      retryable: classified.retryable,
    }];
  }),
);

assert.deepEqual(snapshot, {
  anthropic_overloaded: { category: 'server_error', retryable: true },
  anthropic_rate_limit: { category: 'rate_limit', retryable: true },
  anthropic_invalid_request: { category: 'client_error', retryable: false },
  anthropic_authentication: { category: 'unknown', retryable: false },
});

console.log('[PASS] LLM error classifier routing snapshot');
