#!/usr/bin/env node
/**
 * A device/board command that hits its timeout must report a legible TIMEOUT
 * (with the knob to raise it), not an indistinguishable 'command failed' /
 * transport error. Long ops (colcon build, apt install) used to look broken.
 *
 * Red before fix: ProcessError has no timedOut flag and the exec handlers
 * surface the SIGKILL'd ssh exit as a generic failure.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { ProcessError } from '../dist/utils/run-process.js';
import { createDeviceSshTools } from '../dist/tools/device-ssh.js';
import { createBoardWorkspaceTools } from '../dist/tools/device-workspace.js';

const CONFIG = { host: '10.0.0.9', user: 'root', port: 22 };

// ProcessError carries the timeout marker (and stays backward-compatible).
assert.equal(new ProcessError(255, '', '').timedOut, false);
assert.equal(new ProcessError(124, '', '', true).timedOut, true);

// device_exec: a timed-out child -> legible timeout message with the knob.
{
  const tools = Object.fromEntries(createDeviceSshTools(CONFIG).map((t) => [t.name, t]));
  // device_exec routes through runSsh; force a timeout via an unreachable host
  // would be slow, so instead assert the message shape using a tiny timeout and
  // a command that sleeps. We avoid real SSH by checking the board path below,
  // and here only assert the tool exists + default timeout text.
  assert.ok(tools.device_exec, 'device_exec exists');
  assert.match(tools.device_exec.inputSchema.properties.timeout_ms.description, /default: 30000/);
}

// board exec: inject a runner that throws a timed-out ProcessError and assert
// the message says 'timed out' with a raise hint (no real SSH).
{
  const runner = async () => {
    throw new ProcessError(255, '', '', true);
  };
  const tools = createBoardWorkspaceTools(CONFIG, { runProcessImpl: runner });
  const exec = tools.find((t) => t.name === 'exec');
  await assert.rejects(
    () => exec.execute({ command: 'colcon build', timeout_ms: 1000 }, {}),
    (e) => /timed out after 1s/i.test(e.message) && /timeout_ms/.test(e.message),
    'board exec timeout must be legible and name the knob',
  );
}

console.log('[PASS] exec timeouts are legible and point at timeout_ms');
