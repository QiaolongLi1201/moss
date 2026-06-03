#!/usr/bin/env node
/**
 * Test: background command tools (exec_background / exec_logs / exec_stop).
 *
 * POSIX-only (uses /bin/sh + sleep). Skipped on Windows.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  clearBackgroundRegistryForTests,
} from '../dist/tools/background-exec.js';

if (process.platform === 'win32') {
  console.log('[SKIP] background-exec tests are POSIX-only');
  process.exit(0);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-bg-'));
const CTX = { workspaceDir: dir, sessionKey: 'test' };

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

console.log('[TEST] a command that exits immediately is reported inline');
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: 'echo boom; exit 3', settle_ms: 1500 }, CTX);
  assert.match(out, /exited immediately \(exit 3\)/, 'immediate crash should surface the exit code');
  assert.match(out, /boom/, 'early output should be captured');
}

console.log('[TEST] a long-running command stays running and is observable');
let id;
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: 'echo up; sleep 5', settle_ms: 300, label: 'srv' },
    CTX,
  );
  const m = out.match(/Started (bg_\d+)/);
  assert.ok(m, `should start and remain running: ${out}`);
  id = m[1];
  assert.match(out, /Still running/);

  const logs = await execLogsTool.execute({ id }, CTX);
  assert.match(logs, /\[running/, 'status should be running');
  assert.match(logs, /up/, 'captured output should include early stdout');
  assert.match(logs, /"srv"/, 'label should be shown');
}

console.log('[TEST] exec_logs with no id lists tracked processes');
{
  const list = await execLogsTool.execute({}, CTX);
  assert.match(list, new RegExp(id), 'list should include the running process id');
}

console.log('[TEST] exec_stop terminates the process');
{
  const stop = await execStopTool.execute({ id }, CTX);
  assert.match(stop, /Stopping/);
  const killed = await waitFor(async () => {
    const s = await execLogsTool.execute({ id }, CTX);
    return /\[(killed|exited)/.test(s);
  });
  assert.ok(killed, 'process should be killed/exited after exec_stop');
}

console.log('[TEST] exec_logs / exec_stop reject unknown ids');
{
  assert.match(await execLogsTool.execute({ id: 'bg_999' }, CTX), /no background process/);
  assert.match(await execStopTool.execute({ id: 'bg_999' }, CTX), /no background process/);
}

console.log('[TEST] dangerous commands are blocked');
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: 'rm -rf /' }, CTX);
  assert.match(out, /blocked/i, 'destructive command must be blocked');
}

await fs.rm(dir, { recursive: true, force: true });
console.log('\n[PASS] background-exec tool tests');
