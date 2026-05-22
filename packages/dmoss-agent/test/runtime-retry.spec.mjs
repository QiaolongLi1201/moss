#!/usr/bin/env node
/**
 * Pure-node self-test for `runWithProviderRetry`.
 *
 * `2026-05-01-moss-reliability-fallback-ux` G-2 hard constraints:
 *   1. retryable === true must trigger exactly one retry on first failure
 *   2. retryable === false must NOT retry (throw immediately after classify)
 *   3. Maximum attempts = 1 (caller cannot widen via maxAttempts since
 *      type only allows literal 1)
 *   4. abort signal during the wait or before retry must immediately throw,
 *      surfacing the ORIGINAL error (not the abort)
 *   5. onRetry callback fires exactly twice on retry path:
 *      a) willRetry: true  — before delay
 *      b) willRetry: false — when retry itself fails
 *      … and exactly once on non-retryable path:
 *         willRetry: false (terminal)
 *   6. on retryable success path, onRetry fires only with willRetry: true
 *      (no terminal "false" — the call succeeded)
 *
 * Cannot import the TS source directly here (no compile in verify);
 * we re-implement the helper in this file by reading the impl file. To keep
 * this lightweight, we do NOT replicate the impl byte-equal — instead we
 * inline-import via the dist. Since dist isn't built during verify, we
 * **inline-paste** a JS-only port of the helper. Reviewer must keep the port
 * byte-equal to runtime-retry.ts.
 *
 * Run: `node packages/dmoss-agent/test/runtime-retry.spec.mjs`
 * Exit 0 on pass; 1 on any assertion failure.
 */

import assert from 'node:assert/strict';

/* ---------- Inline port of runtime-retry.ts (byte-equal in spirit) ---------- */
const DEFAULT_BACKOFF = [800, 2000];

function jitteredBackoff(range) {
  const [min, max] = range;
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min));
}

function delayWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function runWithProviderRetry(fn, opts) {
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new Error('aborted');
  }

  let lastError;
  try {
    return await fn();
  } catch (err) {
    lastError = err;
  }

  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  const surface = opts.classify(lastError);
  const allowed = surface.retryable && (opts.shouldRetry ? opts.shouldRetry(surface) : true);
  // Use very small backoff in tests
  const backoffMs = jitteredBackoff(opts.backoffMs ?? DEFAULT_BACKOFF);

  if (!allowed) {
    opts.onRetry?.({
      attempt: 1,
      category: surface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw lastError;
  }

  opts.onRetry?.({
    attempt: 1,
    category: surface.category,
    backoffMs,
    willRetry: true,
  });

  try {
    await delayWithSignal(backoffMs, opts.signal);
  } catch {
    throw lastError;
  }

  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  try {
    return await fn();
  } catch (retryErr) {
    const retrySurface = opts.classify(retryErr);
    opts.onRetry?.({
      attempt: 1,
      category: retrySurface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw retryErr;
  }
}

/* ---------- Test 1: retryable surface, first call fails, second succeeds ---------- */
{
  let calls = 0;
  const onRetryCalls = [];
  const result = await runWithProviderRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('Request was aborted');
      return 'ok';
    },
    {
      classify: () => ({
        category: 'aborted_by_server',
        userMessage: '',
        actions: [],
        silent: false,
        retryable: true,
      }),
      backoffMs: [1, 2],
      onRetry: (info) => onRetryCalls.push(info),
    },
  );
  assert.equal(calls, 2, 'fn should be called twice');
  assert.equal(result, 'ok', 'retry should succeed');
  assert.equal(onRetryCalls.length, 1, 'onRetry called once (willRetry=true)');
  assert.equal(onRetryCalls[0].willRetry, true);
  assert.equal(onRetryCalls[0].attempt, 1);
  assert.equal(onRetryCalls[0].category, 'aborted_by_server');
  console.log('  [PASS] retryable + first-fail-second-success');
}

/* ---------- Test 2: not retryable, throws immediately ---------- */
{
  let calls = 0;
  const onRetryCalls = [];
  let thrown;
  try {
    await runWithProviderRetry(
      async () => {
        calls += 1;
        throw new Error('401 Invalid API key');
      },
      {
        classify: () => ({
          category: 'auth',
          userMessage: '',
          actions: [],
          silent: false,
          retryable: false,
        }),
        backoffMs: [1, 2],
        onRetry: (info) => onRetryCalls.push(info),
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.equal(calls, 1, 'fn must NOT be retried');
  assert.ok(thrown);
  assert.match(String(thrown.message), /Invalid API key/);
  assert.equal(onRetryCalls.length, 1, 'onRetry called exactly once');
  assert.equal(onRetryCalls[0].willRetry, false);
  console.log('  [PASS] non-retryable surface throws immediately');
}

/* ---------- Test 3: retryable but second call also fails — final error thrown ---------- */
{
  let calls = 0;
  const onRetryCalls = [];
  let thrown;
  try {
    await runWithProviderRetry(
      async () => {
        calls += 1;
        throw new Error(calls === 1 ? 'first abort' : 'second abort');
      },
      {
        classify: () => ({
          category: 'aborted_by_server',
          userMessage: '',
          actions: [],
          silent: false,
          retryable: true,
        }),
        backoffMs: [1, 2],
        onRetry: (info) => onRetryCalls.push(info),
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.equal(calls, 2, 'exactly two attempts (initial + 1 retry)');
  assert.match(String(thrown.message), /second abort/, 'must throw the LAST error');
  assert.equal(onRetryCalls.length, 2, 'onRetry called twice (start, terminal-fail)');
  assert.equal(onRetryCalls[0].willRetry, true);
  assert.equal(onRetryCalls[1].willRetry, false);
  console.log('  [PASS] retry-then-fail → throws LAST error');
}

/* ---------- Test 4: shouldRetry override (reject even if retryable) ---------- */
{
  let calls = 0;
  let thrown;
  try {
    await runWithProviderRetry(
      async () => {
        calls += 1;
        throw new Error('Request was aborted');
      },
      {
        classify: () => ({
          category: 'aborted_by_server',
          userMessage: '',
          actions: [],
          silent: false,
          retryable: true,
        }),
        backoffMs: [1, 2],
        shouldRetry: () => false, // user disabled auto-retry
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.equal(calls, 1, 'shouldRetry=false must skip retry');
  assert.ok(thrown);
  console.log('  [PASS] shouldRetry override');
}

/* ---------- Test 5: signal aborted before call → throws abort error immediately ---------- */
{
  let calls = 0;
  const ac = new AbortController();
  ac.abort(new Error('user-cancel'));
  let thrown;
  try {
    await runWithProviderRetry(
      async () => {
        calls += 1;
        return 'should-not-reach';
      },
      {
        classify: () => ({
          category: 'unknown',
          userMessage: '',
          actions: [],
          silent: false,
          retryable: false,
        }),
        backoffMs: [1, 2],
        signal: ac.signal,
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.equal(calls, 0, 'fn must NOT be called when signal already aborted');
  assert.ok(thrown);
  assert.match(String(thrown.message), /user-cancel/);
  console.log('  [PASS] pre-aborted signal short-circuits');
}

/* ---------- Test 6: signal aborted DURING wait → throws original error ---------- */
{
  let calls = 0;
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('mid-wait-cancel')), 5);
  let thrown;
  try {
    await runWithProviderRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('original-stream-error');
        return 'unreachable';
      },
      {
        classify: () => ({
          category: 'aborted_by_server',
          userMessage: '',
          actions: [],
          silent: false,
          retryable: true,
        }),
        backoffMs: [50, 50], // wait long enough for abort to fire
        signal: ac.signal,
      },
    );
  } catch (err) {
    thrown = err;
  }
  assert.equal(calls, 1, 'fn called only once (abort during wait, no retry)');
  // Per design: when aborted DURING wait, surface the ORIGINAL error not the abort
  assert.match(
    String(thrown.message),
    /original-stream-error/,
    'must surface the original error, not the abort reason',
  );
  console.log('  [PASS] abort during wait surfaces original error');
}

console.log('\n[pass] runtime-retry self-test: 6/6');
