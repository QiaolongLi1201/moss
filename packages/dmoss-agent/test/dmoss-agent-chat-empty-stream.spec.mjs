#!/usr/bin/env node
/**
 * Regression tests for DmossAgent.chat() stream termination semantics.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-chat-empty-stream.spec.mjs
 */

import assert from 'node:assert/strict';
import { DmossAgent } from '../dist/core/index.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

async function callChatWithStream(streamFactory) {
  return DmossAgent.prototype.chat.call(
    { streamChat: streamFactory },
    'test-session',
    'hello',
  );
}

{
  await assert.rejects(
    () => callChatWithStream(async function* () {
      // Empty stream: no done and no error event.
    }),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /ended without done or error/i);
      return true;
    },
  );
  console.log('[PASS] chat() rejects when stream ends without done or error');
}

{
  await assert.rejects(
    () => callChatWithStream(async function* () {
      yield { type: 'error', error: 'provider failed after partial stream', retriable: false };
      yield {
        type: 'done',
        result: {
          response: 'stale success',
          toolCalls: [],
          toolResults: [],
          stopReason: 'end_turn',
        },
      };
    }),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /provider failed/);
      return true;
    },
  );
  console.log('[PASS] chat() gives error event precedence over later done');
}

{
  await assert.rejects(
    () => callChatWithStream(async function* () {
      yield {
        type: 'error',
        error: {
          role: 'assistant',
          errorMessage: 'real provider failure',
          stopReason: 'error',
          content: [],
        },
        retriable: false,
      };
    }),
    (err) => {
      assert.ok(err instanceof DmossError);
      assert.equal(err.code, ErrorCode.INTERNAL_INVARIANT_VIOLATED);
      assert.match(err.message, /real provider failure/);
      assert.notEqual(err.message, '[object Object]');
      return true;
    },
  );
  console.log('[PASS] chat() formats object error events readably');
}

console.log('[PASS] DmossAgent.chat empty/error stream regressions');
