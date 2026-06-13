#!/usr/bin/env node
/**
 * Compaction replay must not silently drop kept history when
 * compaction.firstKeptEntryId is missing from the path (corruption/race — the
 * JSONL codec only warns on load). Before the fix, buildSessionContext never
 * flipped foundFirstKept, so every pre-compaction entry was dropped, losing
 * recent history the summary does NOT cover. Red before / green after.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/session-compaction-replay.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../dist/core/session/session-manager.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-compaction-replay-'));
try {
  const sm = new SessionManager(tmpDir);
  const key = 's1';

  await sm.append(key, { role: 'user', content: 'PRECOMP-1' });
  await sm.append(key, { role: 'assistant', content: 'PRECOMP-2' });
  await sm.append(key, { role: 'user', content: 'PRECOMP-3' });
  // Compaction whose firstKeptEntryId does NOT exist in the path.
  await sm.appendCompaction(key, 'THE-COMPACTION-SUMMARY', 'nonexistent-kept-id', 100);
  await sm.append(key, { role: 'assistant', content: 'POSTCOMP-1' });

  const ctx = await sm.load(key);
  const text = JSON.stringify(ctx);

  assert.match(text, /THE-COMPACTION-SUMMARY/, 'compaction summary must be replayed');
  assert.match(text, /POSTCOMP-1/, 'post-compaction message must be present');
  // The core bug: pre-compaction kept messages must NOT vanish when
  // firstKeptEntryId is missing.
  assert.match(text, /PRECOMP-1/, 'pre-compaction history must not be lost when firstKeptEntryId is missing');
  assert.match(text, /PRECOMP-3/, 'all pre-compaction messages preserved');

  console.log('  [PASS] compaction replay preserves history when firstKeptEntryId is missing');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
