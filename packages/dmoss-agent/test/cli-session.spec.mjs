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
  const first = await resolveCliSession({ command: 'chat', store });
  const second = await resolveCliSession({ command: 'chat', store });
  assert.match(first.sessionKey, /^cli-/);
  assert.match(second.sessionKey, /^cli-/);
  assert.notEqual(second.sessionKey, first.sessionKey);
  assert.equal(first.forked, false);
  assert.equal(second.forked, false);
}

{
  const session = await resolveCliSession({ command: 'chat', store, sessionKey: 'cli' });
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
{
  // resume/fork of a non-existent (typo'd) explicit key must NOT print a false
  // "Resuming session" notice and run empty — it must surface a clear error.
  const resumeMissing = await resolveCliSession({ command: 'resume', store, sessionKey: 'does-not-exist' });
  assert.match(resumeMissing.error, /No saved session named "does-not-exist"/);
  assert.equal(resumeMissing.notice, undefined);

  const forkMissing = await resolveCliSession({ command: 'fork', store, sessionKey: 'also-missing' });
  assert.match(forkMissing.error, /No saved session named "also-missing"/);
  assert.equal(forkMissing.notice, undefined);

  // An explicit key that DOES exist still resolves cleanly with no error.
  const resumeReal = await resolveCliSession({ command: 'resume', store, sessionKey: 'newer' });
  assert.equal(resumeReal.error, undefined);
  assert.equal(resumeReal.sessionKey, 'newer');
  assert.match(resumeReal.notice, /Resuming session/);
}

console.log('[PASS] CLI session resume rejects missing explicit keys');
