#!/usr/bin/env node
/**
 * Regression tests for the "success claim without verified outcome" class:
 *  - SSH failures must become THROWN errors, never success-looking text
 *  - ros2_launch must not claim "Launched" for a process that died within 1s
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/ssh-failure-class.spec.mjs
 */
import assert from 'node:assert/strict';
import { sshFailureToError, buildSshCommand } from '../dist/tools/ssh-utils.js';
import { ProcessError } from '../dist/utils/run-process.js';
import {
  ROS2_LAUNCH_OK_MARKER,
  ROS2_LAUNCH_DEAD_MARKER,
  interpretRos2LaunchOutput,
} from '../dist/tools/device-ros2.js';

// ── buildSshCommand: remote command must be passed RAW ─────────────────────
// Regression: wrapping the whole remote command in quotes made the remote
// shell treat it as ONE program name ("bash: uname -n || hostname: No such
// file or directory"), silently breaking every multi-word SSH tool command.
{
  const args = buildSshCommand({ host: '10.0.0.1', user: 'root', port: 22 }, 'uname -n 2>/dev/null || hostname');
  const remote = args[args.length - 1];
  assert.equal(remote, 'uname -n 2>/dev/null || hostname', 'remote command must not be wrapped in quotes');
  assert.ok(!remote.startsWith("'"), 'no leading quote');
  assert.equal(args[args.length - 2], 'root@10.0.0.1');
}

// ── sshFailureToError ──────────────────────────────────────────────────────

{
  // ProcessError with output → Error carrying that output (must be thrown by callers)
  const err = sshFailureToError(new ProcessError(255, 'partial stdout', 'Permission denied'), 'ssh');
  assert.ok(err instanceof Error);
  assert.match(err.message, /partial stdout/);
  assert.match(err.message, /Permission denied/);
}

{
  // ProcessError without output → Error with exit message
  const err = sshFailureToError(new ProcessError(255, '', ''), 'ssh');
  assert.ok(err instanceof Error);
  assert.match(err.message, /exited with code 255/);
}

{
  // Missing ssh executable (ENOENT) → actionable install-hint Error
  const enoent = Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT', path: 'ssh' });
  const err = sshFailureToError(enoent, 'ssh');
  assert.ok(err instanceof Error);
  assert.match(err.message, /ssh/i);
}

{
  // Unknown error shapes are not swallowed — caller must wrap them
  assert.equal(sshFailureToError(new Error('something else'), 'ssh'), null);
}

// ── interpretRos2LaunchOutput ──────────────────────────────────────────────

{
  // Alive after 1s → honest success including pid
  const msg = interpretRos2LaunchOutput(`${ROS2_LAUNCH_OK_MARKER} pid=4242`, 'demo_pkg', 'demo.launch.py');
  assert.match(msg, /Launched demo_pkg\/demo\.launch\.py/);
  assert.match(msg, /pid 4242/);
  assert.match(msg, /alive after 1s/);
}

{
  // Died within 1s → must THROW, with the log tail, never claim Launched
  assert.throws(
    () => interpretRos2LaunchOutput(`${ROS2_LAUNCH_DEAD_MARKER}\nPackage 'demo_pkg' not found`, 'demo_pkg', 'demo.launch.py'),
    (err) => {
      assert.match(err.message, /did NOT start/);
      assert.match(err.message, /Package 'demo_pkg' not found/);
      assert.doesNotMatch(err.message, /^Launched/);
      return true;
    },
  );
}

{
  // Unexpected output (no marker) → throw rather than guess success
  assert.throws(
    () => interpretRos2LaunchOutput('garbage', 'p', 'l'),
    /could not verify/,
  );
}

console.log('[PASS] SSH failure class: throws instead of success-looking text; ros2_launch verifies liveness');
