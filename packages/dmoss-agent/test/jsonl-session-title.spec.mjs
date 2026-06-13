#!/usr/bin/env node
/**
 * JsonlSessionStore derives a human-readable title from the first user message,
 * and the TUI session pickers surface it instead of leaving the bare key alone.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/jsonl-session-title.spec.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlSessionStore } from '../dist/core/session/jsonl-session-store.js';
import { formatTuiSessions } from '../dist/cli/tui.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dmoss-jsonl-session-title-'));
const store = new JsonlSessionStore({ dir });

// First user message becomes the title; assistant/system content is ignored.
await store.appendMessage('cli-20260613-deploy', {
  role: 'assistant',
  content: 'system preamble that must not become the title',
});
await store.appendMessage('cli-20260613-deploy', {
  role: 'user',
  content: 'Deploy the YOLO model to the RDK X5 board',
});

// Over-long first messages are length-capped so they cannot blow out the picker.
const longMessage = 'x'.repeat(200);
await store.appendMessage('cli-20260613-long', { role: 'user', content: longMessage });

// Content-block (image+text) user messages still yield the text part.
await store.appendMessage('cli-20260613-blocks', {
  role: 'user',
  content: [
    { type: 'image', data: 'xxx', mimeType: 'image/png' },
    { type: 'text', text: 'Why does the camera node crash on startup?' },
  ],
});

// A session with no user message must not fabricate a title.
await store.appendMessage('cli-20260613-empty', {
  role: 'assistant',
  content: 'only assistant content here',
});

const sessions = await store.listSessions();
const byKey = Object.fromEntries(sessions.map((s) => [s.sessionKey, s]));

assert.equal(
  byKey['cli-20260613-deploy'].title,
  'Deploy the YOLO model to the RDK X5 board',
  'title should come from the first user message, not assistant content',
);
assert.ok(
  byKey['cli-20260613-long'].title.length <= 80,
  'over-long titles must be length-capped',
);
assert.ok(
  byKey['cli-20260613-long'].title.endsWith('…'),
  'truncated titles should end with an ellipsis',
);
assert.equal(
  byKey['cli-20260613-blocks'].title,
  'Why does the camera node crash on startup?',
  'title should extract the text part of a content-block user message',
);
assert.equal(
  byKey['cli-20260613-empty'].title,
  undefined,
  'sessions with no user message must not fabricate a title',
);

console.log('  [PASS] JsonlSessionStore derives title from the first user message');

// The TUI session list surfaces the title so bare cli-<timestamp> keys are legible.
const rendered = formatTuiSessions(sessions, 'cli-20260613-deploy');
assert.match(
  rendered,
  /Deploy the YOLO model to the RDK X5 board/,
  'formatTuiSessions should surface the saved title alongside the key',
);
assert.match(
  rendered,
  /Why does the camera node crash/,
  'formatTuiSessions should surface each session title',
);

console.log('  [PASS] formatTuiSessions surfaces the saved session title');
