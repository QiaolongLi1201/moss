#!/usr/bin/env node
/**
 * Regression tests for channel bridge chat timeouts.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/channel-bridge-timeout.spec.mjs
 */

import assert from 'node:assert/strict';
import { bridgeAgentToChannel } from '../dist/channels/index.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

class FakeChannel {
  id = 'fake-channel';
  displayName = 'Fake Channel';
  handler = null;
  async start() {}
  async stop() {}
  isRunning() { return true; }
  onMessage(handler) {
    this.handler = handler;
  }
  send(text, senderId = 'sender-1') {
    assert.ok(this.handler, 'handler must be registered');
    return this.handler({
      id: `${Date.now()}-${Math.random()}`,
      senderId,
      text,
      timestamp: Date.now(),
    });
  }
}

function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`test timed out after ${ms}ms`)), ms),
    ),
  ]);
}

const channel = new FakeChannel();
let calls = 0;
const agent = {
  async chat(_sessionKey, text, options) {
    calls += 1;
    if (text === 'slow') {
      return new Promise((resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => {
          reject(options.abortSignal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    }
    return {
      response: `ok:${text}`,
      toolCalls: [],
      toolResults: [],
      stopReason: 'end_turn',
    };
  },
};

bridgeAgentToChannel(agent, channel, { chatTimeoutMs: 50 });

await assert.rejects(
  () => withDeadline(channel.send('slow'), 500),
  (err) => {
    assert.ok(err instanceof DmossError);
    assert.equal(err.code, ErrorCode.TOOL_EXECUTION_TIMEOUT);
    return true;
  },
);

const after = await withDeadline(channel.send('after-timeout'), 500);
assert.deepEqual(after, { text: 'ok:after-timeout' });
assert.equal(calls, 2, 'second message should run after the timed-out message settles');

{
  const ignoredAbortChannel = new FakeChannel();
  let slowResolved = false;
  let nextStartedBeforeSlowSettled = false;
  let releaseSlow;
  const ignoredAbortAgent = {
    async chat(_sessionKey, text) {
      if (text === 'ignores-abort') {
        return new Promise((resolve) => {
          releaseSlow = () => {
            slowResolved = true;
            resolve({
              response: 'late',
              toolCalls: [],
              toolResults: [],
              stopReason: 'end_turn',
            });
          };
        });
      }
      nextStartedBeforeSlowSettled = !slowResolved;
      return {
        response: `ok:${text}`,
        toolCalls: [],
        toolResults: [],
        stopReason: 'end_turn',
      };
    },
  };

  bridgeAgentToChannel(ignoredAbortAgent, ignoredAbortChannel, { chatTimeoutMs: 50 });
  await assert.rejects(
    () => withDeadline(ignoredAbortChannel.send('ignores-abort'), 500),
    (err) => err instanceof DmossError && err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT,
  );
  const recovered = await withDeadline(ignoredAbortChannel.send('after-ignored-abort'), 500);
  assert.deepEqual(recovered, { text: 'ok:after-ignored-abort' });
  assert.equal(
    nextStartedBeforeSlowSettled,
    true,
    'bridge intentionally releases the channel queue after timeout even if the agent ignores abort',
  );
  releaseSlow();
}

{
  const cappedChannel = new FakeChannel();
  let releaseHold;
  let overflowEvent = null;
  const cappedAgent = {
    async chat(_sessionKey, text) {
      if (text === 'hold') {
        return new Promise((resolve) => {
          releaseHold = () => resolve({
            response: 'released',
            toolCalls: [],
            toolResults: [],
            stopReason: 'end_turn',
          });
        });
      }
      return {
        response: `ok:${text}`,
        toolCalls: [],
        toolResults: [],
        stopReason: 'end_turn',
      };
    },
  };

  bridgeAgentToChannel(cappedAgent, cappedChannel, {
    chatTimeoutMs: 1_000,
    maxSessionQueues: 1,
    onQueueOverflow: (event) => {
      overflowEvent = event;
    },
  });
  const held = cappedChannel.send('hold', 'sender-a');
  await assert.rejects(
    () => withDeadline(cappedChannel.send('second-sender', 'sender-b'), 500),
    (err) => err instanceof DmossError && err.code === ErrorCode.TOOL_EXECUTION_FAILED,
  );
  assert.equal(overflowEvent?.channelId, 'fake-channel');
  assert.equal(overflowEvent?.queueSize, 1);
  assert.equal(overflowEvent?.maxSessionQueues, 1);
  releaseHold();
  assert.deepEqual(await withDeadline(held, 500), { text: 'released' });
}

console.log('[PASS] channel bridge times out stalled chat calls and continues the queue');
