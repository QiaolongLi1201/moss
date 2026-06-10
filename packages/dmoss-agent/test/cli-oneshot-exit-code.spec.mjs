#!/usr/bin/env node
/**
 * Regression: one-shot TEXT mode must exit non-zero when the run ends in an
 * error. Before the fix, `process.exitCode` was only set for headless/json
 * output, so `moss "task"` reported success (exit 0) to scripts/CI even when
 * every turn failed (e.g. unreachable provider).
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-oneshot-exit-code.spec.mjs
 */
import assert from 'node:assert/strict';
import { runOneShot } from '../dist/cli/oneshot.js';

function makeFakeAgent(events) {
  return {
    config: {
      model: 'fake-model',
      sessionStore: {
        async loadMessages() {
          return [];
        },
      },
    },
    tools: {
      getAll() {
        return [{ name: 'read_file' }];
      },
    },
    async *streamChat() {
      for (const event of events) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
  };
}

async function withExitCode(fn) {
  const original = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return process.exitCode;
  } finally {
    process.exitCode = original;
  }
}

// 1) Error event followed by done → text mode must exit 1.
{
  const code = await withExitCode(() =>
    runOneShot(
      makeFakeAgent([
        { type: 'turn_start', turn: 1 },
        { type: 'error', error: 'LLM stream error: fetch failed' },
        { type: 'done', result: { response: '', stopReason: 'error' } },
      ]),
      'hi',
      undefined,
      { sessionKey: 'exitcode-error-done', outputFormat: 'text' },
    ),
  );
  assert.equal(code, 1, 'text mode with error result must set exitCode=1');
  console.log('  [PASS] text mode: error result sets exitCode=1');
}

// 2) Error event with NO done (stream ends after fatal) → still exit 1.
{
  const code = await withExitCode(() =>
    runOneShot(
      makeFakeAgent([
        { type: 'turn_start', turn: 1 },
        { type: 'error', error: 'LLM stream error: fetch failed' },
      ]),
      'hi',
      undefined,
      { sessionKey: 'exitcode-error-no-done', outputFormat: 'text' },
    ),
  );
  assert.equal(code, 1, 'text mode with trailing error and no result must set exitCode=1');
  console.log('  [PASS] text mode: trailing error without done sets exitCode=1');
}

// 3) Successful run keeps exit code 0/undefined.
{
  const code = await withExitCode(() =>
    runOneShot(
      makeFakeAgent([
        { type: 'turn_start', turn: 1 },
        { type: 'text_delta', delta: 'all good' },
        { type: 'done', result: { response: 'all good', stopReason: 'end_turn' } },
      ]),
      'hi',
      undefined,
      { sessionKey: 'exitcode-success', outputFormat: 'text' },
    ),
  );
  assert.notEqual(code, 1, 'successful run must not set exitCode=1');
  console.log('  [PASS] text mode: success keeps exit code clean');
}

console.log('[PASS] one-shot exit codes');
