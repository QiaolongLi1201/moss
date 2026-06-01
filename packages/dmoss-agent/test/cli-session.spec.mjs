#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-session.spec.mjs
 */
import assert from 'node:assert/strict';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { resolveCliSession } from '../dist/cli/session.js';

const store = new InMemorySessionStore();
await store.appendMessage('older', { role: 'user', content: 'old' });
await new Promise((resolve) => setTimeout(resolve, 2));
await store.appendMessage('newer', { role: 'user', content: 'new' });

{
  const session = await resolveCliSession({ command: 'chat', store });
  assert.equal(session.sessionKey, 'cli');
  assert.equal(session.forked, false);
}

{
  const session = await resolveCliSession({ command: 'resume', store, useLast: true });
  assert.equal(session.sessionKey, 'newer');
  assert.match(session.notice, /Resuming session/);
}

{
  const session = await resolveCliSession({ command: 'fork', store, sessionKey: 'older' });
  assert.equal(session.forked, true);
  assert.equal(session.sourceSessionKey, 'older');
  assert.match(session.sessionKey, /^cli-fork-/);
  assert.deepEqual(await store.loadMessages(session.sessionKey), await store.loadMessages('older'));
}

console.log('[PASS] CLI session resume and fork resolve existing JSONL sessions');
