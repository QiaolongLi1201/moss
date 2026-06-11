#!/usr/bin/env node
/**
 * /memory editor resolution + `#` quick-add memory helpers.
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveEditorCommand,
  parseQuickAddMemory,
  appendQuickAddMemory,
} from '../dist/cli/memory-editor.js';

// ── editor resolution: $VISUAL beats $EDITOR; args split; never null ──
assert.deepEqual(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }), { command: 'vim', args: [] });
assert.deepEqual(resolveEditorCommand({ EDITOR: 'nano' }), { command: 'nano', args: [] });
assert.deepEqual(resolveEditorCommand({ EDITOR: 'code -w' }), { command: 'code', args: ['-w'] });
{
  const fb = resolveEditorCommand({});
  assert.ok(fb && typeof fb.command === 'string' && fb.command.length > 0, 'fallback is never null');
}

// ── # quick-add parser: single # + space + text; not ## or bare # ──
assert.equal(parseQuickAddMemory('#remember this'), null, 'no space → not a quick-add');
assert.equal(parseQuickAddMemory('# remember this'), 'remember this');
assert.equal(parseQuickAddMemory('#  trim me  '), 'trim me');
assert.equal(parseQuickAddMemory('## markdown heading'), null, 'double-hash heading sent normally');
assert.equal(parseQuickAddMemory('hello'), null);

// ── appendQuickAddMemory: creates section, appends under it, idempotent header ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-mem-'));
  try {
    const target = appendQuickAddMemory(tmp, 'first fact', '# AGENTS.md\n');
    let body = fs.readFileSync(target, 'utf8');
    assert.ok(body.includes('## Memories'));
    assert.ok(body.includes('- first fact'));
    appendQuickAddMemory(tmp, 'second fact', '# AGENTS.md\n');
    body = fs.readFileSync(target, 'utf8');
    assert.ok(body.includes('- second fact'));
    assert.equal((body.match(/## Memories/g) || []).length, 1, 'exactly one Memories section');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('[PASS] cli-memory-editor: editor resolution + # quick-add helpers');
