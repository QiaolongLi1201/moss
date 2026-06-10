#!/usr/bin/env node
/**
 * Regression: provider connection failures must name the target host and the
 * underlying cause. Bare "fetch failed" gave users nothing to act on when a
 * baseUrl was mistyped or unreachable.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/connection-error.spec.mjs
 */
import assert from 'node:assert/strict';
import { fetchWithConnectionContext } from '../dist/provider/connection-error.js';

// 1) Connection refused → message contains host and cause code.
{
  let caught;
  try {
    await fetchWithConnectionContext('http://127.0.0.1:9/v1/chat/completions', { method: 'POST' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'unreachable port must reject');
  assert.match(caught.message, /127\.0\.0\.1:9/, `message must name the host, got: ${caught.message}`);
  // The exact cause text varies by platform/undici ("bad port", ECONNREFUSED…);
  // what matters is that SOME cause is appended after the host.
  assert.match(caught.message, /127\.0\.0\.1:9 \(.+\)/, `message must surface the cause, got: ${caught.message}`);
  console.log('  [PASS] refused connection names host and cause');
}

// 2) Abort is preserved untouched (the agent loop branches on AbortError).
{
  const ctrl = new AbortController();
  ctrl.abort();
  let caught;
  try {
    await fetchWithConnectionContext('http://127.0.0.1:9/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'aborted fetch must reject');
  assert.doesNotMatch(String(caught.message ?? ''), /for 127\.0\.0\.1:9 \(/, 'aborts must not be re-wrapped as connection failures');
  console.log('  [PASS] aborts pass through unwrapped');
}

console.log('[PASS] connection error context');
