#!/usr/bin/env node
/**
 * Test: config-driven hooks (createConfiguredHookCallbacks).
 *
 * POSIX-only (uses /bin/sh + exit codes). Skipped on Windows.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';

if (process.platform === 'win32') {
  console.log('[SKIP] cli-hooks tests are POSIX-only');
  process.exit(0);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-hooks-'));

function req(name, input = {}) {
  return { tool: { name }, input, sessionKey: 'k' };
}
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function waitForFile(p, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await exists(p)) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

console.log('[TEST] a blocking PreToolUse hook that exits non-zero vetoes the tool');
{
  const h = createConfiguredHookCallbacks(
    { PreToolUse: [{ matcher: 'exec', command: 'echo nope 1>&2; exit 1' }] },
    { workspaceDir: dir },
  );
  const d = await h.onBeforeToolExec(req('exec', { command: 'ls' }));
  assert.equal(d.approved, false);
  assert.match(d.reason, /Blocked by PreToolUse hook/);
  assert.match(d.reason, /nope/, 'hook stderr should appear in the block reason');
}

console.log('[TEST] a PreToolUse hook that exits 0 approves');
{
  const h = createConfiguredHookCallbacks({ PreToolUse: [{ command: 'exit 0' }] }, { workspaceDir: dir });
  const d = await h.onBeforeToolExec(req('exec'));
  assert.equal(d.approved, true);
}

console.log('[TEST] matcher scopes the hook to specific tools');
{
  const h = createConfiguredHookCallbacks(
    { PreToolUse: [{ matcher: 'write_file', command: 'exit 1' }] },
    { workspaceDir: dir },
  );
  const d = await h.onBeforeToolExec(req('read_file'));
  assert.equal(d.approved, true, 'a non-matching tool must not be blocked');
}

console.log('[TEST] a non-blocking PreToolUse hook never vetoes, even on failure');
{
  const h = createConfiguredHookCallbacks(
    { PreToolUse: [{ command: 'exit 7', blocking: false }] },
    { workspaceDir: dir },
  );
  const d = await h.onBeforeToolExec(req('exec'));
  assert.equal(d.approved, true);
}

console.log('[TEST] PostToolUse runs as a side effect and receives MOSS_TOOL_NAME');
{
  const sentinel = path.join(dir, 'post.txt');
  const h = createConfiguredHookCallbacks(
    { PostToolUse: [{ matcher: 'write_file', command: `printf '%s' "$MOSS_TOOL_NAME" > "${sentinel}"` }] },
    { workspaceDir: dir },
  );
  h.onToolResult({ id: '1', name: 'write_file', input: {} }, { toolUseId: '1', content: 'ok' });
  assert.ok(await waitForFile(sentinel), 'PostToolUse hook should have run');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'write_file', 'MOSS_TOOL_NAME env should be passed');
}

console.log('[TEST] SessionStart hooks run');
{
  const sentinel = path.join(dir, 'session.txt');
  const h = createConfiguredHookCallbacks(
    { SessionStart: [{ command: `echo started > "${sentinel}"` }] },
    { workspaceDir: dir },
  );
  await h.runSessionStart();
  assert.ok(await exists(sentinel), 'SessionStart hook should have run');
}

console.log('[TEST] no hooks configured → no callbacks, hasHooks=false');
{
  const h = createConfiguredHookCallbacks(undefined, { workspaceDir: dir });
  assert.equal(h.onBeforeToolExec, undefined);
  assert.equal(h.onToolResult, undefined);
  assert.equal(h.hasHooks, false);
}

await fs.rm(dir, { recursive: true, force: true });
console.log('\n[PASS] config-driven hooks tests');
