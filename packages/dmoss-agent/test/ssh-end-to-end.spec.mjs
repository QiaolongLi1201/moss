#!/usr/bin/env node
/**
 * End-to-end SSH semantics test: a fake `ssh` that mimics sshd exactly
 * (joins remote-command args, runs them through `bash -c` in a fake board
 * home) plus a fake `sshpass` that enforces the SSHPASS env contract.
 *
 * This is the system-level regression net for the quoting bug that broke
 * every multi-word SSH command ("bash: uname -n || hostname: No such file
 * or directory") — and proves /connect + board mode work against a real
 * shell, not just against mocks.
 *
 * Run after `npm run build -w @rdk-moss/agent`. POSIX only (skips on win32).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.platform === 'win32') {
  console.log('[SKIP] ssh end-to-end (POSIX fake-ssh harness)');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-ssh-e2e-'));
const fakeBin = path.join(work, 'bin');
const boardHome = path.join(work, 'board-home');
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(boardHome, { recursive: true });

// Fake ssh: skip options, first non-flag arg is user@host, the rest is the
// remote command (sshd joins args with spaces and runs $SHELL -c <string>).
fs.writeFileSync(
  path.join(fakeBin, 'ssh'),
  `#!/bin/bash
args=("$@")
cmd=""
target=""
i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -o|-p|-i) i=$((i+2)); continue ;;
    -*) i=$((i+1)); continue ;;
  esac
  if [ -z "$target" ]; then
    target="$a"
  else
    if [ -z "$cmd" ]; then cmd="$a"; else cmd="$cmd $a"; fi
  fi
  i=$((i+1))
done
case "$target" in
  *authfail*)
    echo "Permission denied (publickey,password)." >&2
    exit 255
    ;;
esac
cd "${boardHome}" || exit 255
exec bash -c "$cmd"
`,
  { mode: 0o755 },
);

// Fake sshpass: require -e + non-empty SSHPASS (exit 5 = bad password), then
// exec the wrapped ssh command.
fs.writeFileSync(
  path.join(fakeBin, 'sshpass'),
  `#!/bin/bash
if [ "$1" != "-e" ]; then echo "fake sshpass: expected -e" >&2; exit 1; fi
if [ -z "$SSHPASS" ]; then exit 5; fi
shift
exec "$@"
`,
  { mode: 0o755 },
);

process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const { probeDeviceSsh, createDeviceSshTools } = await import('../dist/tools/device-ssh.js');
const { createBoardWorkspaceTools } = await import('../dist/tools/device-workspace.js');
const { connectDeviceForSession, disconnectDeviceForSession } = await import('../dist/cli/device-connect.js');

const CONFIG = { host: '203.0.113.10', user: 'root', port: 22 };

// 1. Probe end-to-end: the multi-word probe command must execute (this exact
//    call failed with "No such file or directory" before the quoting fix).
{
  const probe = await probeDeviceSsh(CONFIG);
  assert.equal(probe.ok, true, `probe must succeed via fake ssh: ${probe.detail}`);
  assert.ok(probe.detail.length > 0, 'probe returns the remote hostname');
}

// 2. Auth failure classification end-to-end (ssh exit 255 + Permission denied).
{
  const probe = await probeDeviceSsh({ host: 'authfail.example', user: 'sunrise', port: 22 });
  assert.equal(probe.ok, false);
  assert.equal(probe.kind, 'auth');
}

// 3. Password path: SSHPASS env must reach sshpass.
{
  const probe = await probeDeviceSsh({ ...CONFIG, password: 'sunrise' });
  assert.equal(probe.ok, true, `sshpass path must work: ${probe.detail}`);
}

// 4. Full /connect with the REAL probe → board mode, then tool round-trips.
{
  const tools = new Map();
  const agent = {
    config: { extraPromptLayers: [] },
    tools: {
      get: (n) => tools.get(n),
      remove: (n) => tools.delete(n),
      register: (t) => tools.set(t.name, t),
    },
  };
  const runtime = {};
  const result = await connectDeviceForSession(agent, runtime, CONFIG);
  assert.equal(result.ok, true, `connect must verify via fake ssh: ${result.message}`);
  assert.match(result.message, /verified, remote hostname/);
  assert.ok(runtime.deviceSession?.boardMode, 'board mode active');

  const byName = Object.fromEntries([...tools.values()].map((t) => [t.name, t]));

  // exec: compound command with pipes — sshd semantics end-to-end.
  const execOut = await byName.exec.execute({ command: 'echo alpha && echo beta | tr a-z A-Z' }, {});
  assert.match(execOut, /alpha/);
  assert.match(execOut, /BETA/);

  // write → read → edit round-trip on the "board" filesystem.
  const writeMsg = await byName.write_file.execute({ path: 'cfg/test.conf', content: 'mode=slow\n' }, {});
  assert.match(writeMsg, /verified/);
  assert.equal(fs.readFileSync(path.join(boardHome, 'cfg/test.conf'), 'utf-8'), 'mode=slow\n');

  const readOut = await byName.read_file.execute({ path: 'cfg/test.conf' }, {});
  assert.match(readOut, /1\tmode=slow/);

  const editMsg = await byName.edit_file.execute({ path: 'cfg/test.conf', old_string: 'slow', new_string: 'fast' }, {});
  assert.match(editMsg, /replaced 1 occurrence/);
  assert.equal(fs.readFileSync(path.join(boardHome, 'cfg/test.conf'), 'utf-8'), 'mode=fast\n');

  // device_exec (hybrid family) with a multi-word command.
  const devOut = await byName.device_exec.execute({ command: 'printf "%s-%s" hello board' }, {});
  assert.equal(devOut, 'hello-board');

  // disconnect restores cleanly.
  const bye = disconnectDeviceForSession(agent, runtime);
  assert.match(bye, /Disconnected/);
  assert.equal(runtime.deviceSession, null);
}

fs.rmSync(work, { recursive: true, force: true });
console.log('[PASS] ssh end-to-end: probe, auth classify, sshpass, board-mode tool round-trips via real shell semantics');
