#!/usr/bin/env node
/**
 * Self-test for tool cancel safety (P0-3).
 *
 * Verifies that device tools using runProcess (spawn-based) properly
 * respond to AbortSignal — a hung command must be killable within 500ms.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/tools-cancel-safety.spec.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess, ProcessError } from '../dist/utils/run-process.js';

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(50);
  }
}

async function assertShellLaunchedChildIsKilled(runShellCommand) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dmoss-run-process-'));
  const pidFile = path.join(tmp, 'child.pid');
  let childPid = 0;

  try {
    const command = `sleep 60 >/dev/null 2>&1 & echo $! > ${shellQuote(pidFile)}; wait`;

    await assert.rejects(
      () => runShellCommand(command),
      (err) => err instanceof ProcessError,
    );

    childPid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0, `invalid child pid: ${childPid}`);
    await waitForProcessExit(childPid);
    assert.equal(processIsAlive(childPid), false, `shell-launched child process still alive: ${childPid}`);
  } finally {
    if (childPid > 0 && processIsAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

// ── Test 1: Normal command completes successfully ──
{
  const result = await runProcess('echo', { args: ['hello world'], timeout: 5000 });
  assert.equal(result.stdout.trim(), 'hello world');
  assert.equal(result.exitCode, 0);
  console.log('[PASS] Normal command completes successfully');
}

// ── Test 2: Command failure returns ProcessError with stdout/stderr ──
{
  try {
    await runProcess('sh', { args: ['-c', 'echo out; echo err >&2; exit 42'], timeout: 5000 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ProcessError, 'must be ProcessError');
    assert.equal(err.exitCode, 42);
    assert.ok(err.stdout.includes('out'));
    assert.ok(err.stderr.includes('err'));
  }
  console.log('[PASS] Command failure returns ProcessError with stdout/stderr');
}

// ── Test 3: Timeout kills the process ──
{
  const start = Date.now();
  try {
    await runProcess('sleep', { args: ['60'], timeout: 500 });
    assert.fail('should have thrown');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert.ok(err instanceof ProcessError, 'must be ProcessError');
    assert.ok(elapsed < 2000, `timeout should kill within 2s, took ${elapsed}ms`);
  }
  console.log('[PASS] Timeout kills the process within 2s');
}

// ── Test 4: AbortSignal kills the process ──
{
  const ac = new AbortController();
  const start = Date.now();
  const promise = runProcess('sleep', { args: ['60'], timeout: 30_000, signal: ac.signal });

  setTimeout(() => ac.abort(), 200);

  try {
    await promise;
    assert.fail('should have thrown');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert.ok(err instanceof ProcessError, 'must be ProcessError');
    assert.ok(elapsed < 1000, `abort should kill within 1s, took ${elapsed}ms`);
  }
  console.log('[PASS] AbortSignal kills the process within 1s');
}

// ── Test 5: Already-aborted signal rejects immediately ──
{
  const ac = new AbortController();
  ac.abort();
  const start = Date.now();
  try {
    await runProcess('sleep', { args: ['60'], timeout: 30_000, signal: ac.signal });
    assert.fail('should have thrown');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `pre-aborted signal should kill quickly, took ${elapsed}ms`);
  }
  console.log('[PASS] Pre-aborted signal rejects quickly');
}

// ── Test 6: maxBuffer truncation ──
{
  const result = await runProcess('sh', {
    args: ['-c', 'yes | head -100000'],
    timeout: 5000,
    maxBuffer: 1024,
  });
  assert.ok(result.stdout.length <= 128 * 1024, `stdout should be bounded, got ${result.stdout.length}`);
  console.log('[PASS] maxBuffer truncation works');
}

// ── Test 7: Non-blocking — event loop stays responsive ──
{
  let tickCount = 0;
  const ticker = setInterval(() => tickCount++, 10);

  const result = await runProcess('sleep', { args: ['0.2'], timeout: 5000 });
  clearInterval(ticker);

  assert.ok(tickCount >= 10, `event loop should have ticked 10+ times during 200ms sleep, got ${tickCount}`);
  assert.equal(result.exitCode, 0);
  console.log(`[PASS] Non-blocking: event loop ticked ${tickCount} times during child process`);
}

// ── Test 8: Timeout kills shell-launched child processes ──
if (process.platform !== 'win32') {
  await assertShellLaunchedChildIsKilled((command) =>
    runProcess('sh', { args: ['-c', command], timeout: 300 }),
  );

  console.log('[PASS] Timeout kills shell-launched child processes');
} else {
  console.log('[SKIP] Timeout kills shell-launched child processes (POSIX-only)');
}

// ── Test 9: AbortSignal kills shell-launched child processes ──
if (process.platform !== 'win32') {
  await assertShellLaunchedChildIsKilled((command) => {
    const ac = new AbortController();
    const promise = runProcess('sh', {
      args: ['-c', command],
      timeout: 30_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 300);
    return promise;
  });

  console.log('[PASS] AbortSignal kills shell-launched child processes');
} else {
  console.log('[SKIP] AbortSignal kills shell-launched child processes (POSIX-only)');
}

console.log('\n[pass] tools-cancel-safety: 9/9');
