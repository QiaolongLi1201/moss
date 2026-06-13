#!/usr/bin/env node
/**
 * Fork-key collision regression: two forks created within the same second must
 * NOT share a key and must NOT overwrite each other's messages.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-session-fork-collision.spec.mjs
 */
import assert from 'node:assert/strict';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { resolveCliSession } from '../dist/cli/session.js';

const store = new InMemorySessionStore();
await store.appendMessage('src-a', { role: 'user', content: 'branch A content' });
await store.appendMessage('src-b', { role: 'user', content: 'branch B content' });

// Two forks back-to-back (same wall-clock second). RED before fix: identical
// cli-fork-<14digits> keys, second replaceMessages clobbers the first branch.
const forkA = await resolveCliSession({ command: 'fork', store, sessionKey: 'src-a' });
const forkB = await resolveCliSession({ command: 'fork', store, sessionKey: 'src-b' });

assert.equal(forkA.forked, true);
assert.equal(forkB.forked, true);
assert.notEqual(forkA.sessionKey, forkB.sessionKey, 'rapid forks must get distinct keys');

const a = await store.loadMessages(forkA.sessionKey);
const b = await store.loadMessages(forkB.sessionKey);
assert.equal(a.length, 1);
assert.equal(b.length, 1);
assert.match(String(a[0].content), /branch A content/, 'fork A keeps its own messages');
assert.match(String(b[0].content), /branch B content/, 'fork B is not overwritten by A');

console.log('[PASS] Rapid forks get unique keys and do not overwrite each other');
