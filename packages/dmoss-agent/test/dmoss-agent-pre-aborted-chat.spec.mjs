#!/usr/bin/env node
/**
 * Regression test for pre-aborted DmossAgent.chat calls.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-pre-aborted-chat.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
} from '../dist/core/index.js';
import { DmossError, ErrorCode } from '../dist/errors.js';

const store = new InMemorySessionStore();
let providerCalled = false;
const provider = {
  id: 'fake-provider',
  displayName: 'Fake Provider',
  async complete() {
    providerCalled = true;
    throw new Error('complete should not be called for pre-aborted chat');
  },
  async stream() {
    providerCalled = true;
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'should not run' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

const agent = new DmossAgent({
  sessionStore: store,
  llmProvider: provider,
  model: 'fake-model',
  domainPrompt: false,
  includeRegisteredKnowledgePrompts: false,
  baseSystemPrompt: 'base',
});

const abortController = new AbortController();
abortController.abort(new Error('cancelled before start'));

await assert.rejects(
  () => agent.chat('pre-aborted-session', 'hello', { abortSignal: abortController.signal }),
  (err) => {
    assert.ok(err instanceof DmossError);
    assert.equal(err.code, ErrorCode.USER_ABORTED);
    return true;
  },
);

assert.equal(providerCalled, false, 'pre-aborted chat must not start the provider');
assert.deepEqual(
  await store.loadMessages('pre-aborted-session'),
  [],
  'pre-aborted chat must not persist user messages or checkpoints',
);

console.log('[PASS] DmossAgent.chat rejects pre-aborted signals without side effects');
