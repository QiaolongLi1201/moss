#!/usr/bin/env node
/**
 * Unit tests for the centralized SSH invocation resolver and the keyPath
 * tilde expansion. These are PURE-function tests: resolveSshInvocation takes a
 * simulated platform + sshpassAvailable so the Windows password path can be
 * asserted on any OS (including the POSIX CI box).
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSshInvocation,
  buildSshCommand,
  runSsh,
  SSH_PASSWORD_ENV_VAR,
} from '../dist/tools/ssh-utils.js';
import { ProcessError } from '../dist/utils/run-process.js';

const baseArgs = ['-o', 'StrictHostKeyChecking=no', '-p', '22', 'root@203.0.113.10', 'uname -n'];

// 1. No password → plain ssh, args untouched, no extra env, no askpass.
{
  const inv = resolveSshInvocation({ host: '203.0.113.10' }, baseArgs, {
    platform: 'linux',
    sshpassAvailable: true,
  });
  assert.equal(inv.bin, 'ssh');
  assert.deepEqual(inv.args, baseArgs);
  assert.equal(inv.askpass, undefined);
  assert.equal(inv.env[SSH_PASSWORD_ENV_VAR], undefined);
  assert.equal(inv.env.SSHPASS, undefined);
}

// 2. Password + sshpass available on POSIX → sshpass path is preserved exactly.
{
  const inv = resolveSshInvocation({ host: '203.0.113.10', password: 'sunrise' }, baseArgs, {
    platform: 'linux',
    sshpassAvailable: true,
  });
  assert.equal(inv.bin, 'sshpass');
  assert.deepEqual(inv.args, ['-e', 'ssh', ...baseArgs]);
  assert.equal(inv.env.SSHPASS, 'sunrise');
  assert.equal(inv.askpass, undefined, 'sshpass path does not use an askpass helper');
}

// 3. Password on win32 → native OpenSSH + SSH_ASKPASS, never sshpass.
{
  const inv = resolveSshInvocation({ host: '203.0.113.10', password: 'sunrise' }, baseArgs, {
    platform: 'win32',
    sshpassAvailable: true, // even if "available", win32 sshpass is not standard → use askpass
  });
  assert.equal(inv.bin, 'ssh', 'win32 password auth must use native ssh, not sshpass');
  // The password-auth options must be present so pubkey is skipped and only
  // one password prompt is allowed.
  const joined = inv.args.join(' ');
  assert.match(joined, /PreferredAuthentications=password,keyboard-interactive/);
  assert.match(joined, /NumberOfPasswordPrompts=1/);
  assert.match(joined, /PubkeyAuthentication=no/);
  // The original args (target + remote command) must still be there, last.
  assert.deepEqual(inv.args.slice(-baseArgs.length), baseArgs);
  // SSH_ASKPASS must be set and point at the helper; the password rides in an
  // env var, NOT in argv (so it never shows up in a process list).
  assert.ok(inv.askpass, 'win32 password path produces an askpass helper path');
  assert.equal(inv.env.SSH_ASKPASS, inv.askpass);
  assert.equal(inv.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(inv.env[SSH_PASSWORD_ENV_VAR], 'sunrise');
  assert.equal(inv.env.SSHPASS, undefined, 'no SSHPASS on the native-ssh path');
  assert.ok(!inv.args.includes('sunrise'), 'password must never appear in argv');
}

// 4. Password on POSIX when sshpass is NOT available → same askpass fallback.
{
  const inv = resolveSshInvocation({ host: '203.0.113.10', password: 'sunrise' }, baseArgs, {
    platform: 'linux',
    sshpassAvailable: false,
  });
  assert.equal(inv.bin, 'ssh');
  assert.match(inv.args.join(' '), /PreferredAuthentications=password,keyboard-interactive/);
  assert.equal(inv.env.SSH_ASKPASS, inv.askpass);
  assert.equal(inv.env[SSH_PASSWORD_ENV_VAR], 'sunrise');
}

// 5. keyPath tilde expansion in buildSshCommand: leading ~/ becomes homedir.
{
  const args = buildSshCommand({ host: '203.0.113.10', keyPath: '~/.ssh/id_rsa' }, 'uname -n');
  const i = args.indexOf('-i');
  assert.ok(i !== -1, '-i flag is present when keyPath is set');
  const expanded = args[i + 1];
  assert.equal(expanded, path.join(os.homedir(), '.ssh/id_rsa'));
  assert.ok(!expanded.startsWith('~'), 'tilde must be expanded to an absolute path');
}

// 6. A bare "~" expands to the homedir itself.
{
  const args = buildSshCommand({ host: '203.0.113.10', keyPath: '~' }, 'uname -n');
  const i = args.indexOf('-i');
  assert.equal(args[i + 1], os.homedir());
}

// 7. A non-tilde keyPath is passed through verbatim.
{
  const args = buildSshCommand({ host: '203.0.113.10', keyPath: '/etc/keys/id_rsa' }, 'uname -n');
  const i = args.indexOf('-i');
  assert.equal(args[i + 1], '/etc/keys/id_rsa');
}

// 8. runSsh askpass lifecycle (forced native path): the helper file is created,
//    used, and deleted; cleanup runs even when the run fails.
{
  let capturedAskpassPath;
  let askpassExistedDuringRun = false;
  const runner = async (bin, opts) => {
    assert.equal(bin, 'ssh', 'forced native path spawns ssh, not sshpass');
    capturedAskpassPath = opts.env.SSH_ASKPASS;
    assert.ok(capturedAskpassPath, 'SSH_ASKPASS is set in the child env');
    askpassExistedDuringRun = fs.existsSync(capturedAskpassPath);
    // The helper reads the password from the env var, not from argv.
    assert.equal(opts.env[SSH_PASSWORD_ENV_VAR], 'sunrise');
    assert.ok(!opts.args.includes('sunrise'), 'password is not in argv');
    return { stdout: 'board-host', stderr: '', exitCode: 0 };
  };

  const out = await runSsh({ host: '203.0.113.10', password: 'sunrise' }, ['root@203.0.113.10', 'uname -n'], {
    runner,
    resolveOpts: { platform: 'linux', sshpassAvailable: false },
  });
  assert.equal(out.stdout, 'board-host');
  assert.equal(askpassExistedDuringRun, true, 'askpass helper exists while ssh runs');
  assert.equal(fs.existsSync(capturedAskpassPath), false, 'askpass helper is deleted afterward');
}

// 9. runSsh deletes the askpass helper even when the run throws.
{
  let capturedAskpassPath;
  const runner = async (_bin, opts) => {
    capturedAskpassPath = opts.env.SSH_ASKPASS;
    throw new ProcessError(255, '', 'Permission denied');
  };
  // runSsh is transport-agnostic: it propagates the raw ProcessError (callers
  // translate it via sshFailureToError) but must still run its cleanup finally.
  await assert.rejects(
    runSsh({ host: '203.0.113.10', password: 'sunrise' }, ['root@203.0.113.10', 'uname -n'], {
      runner,
      resolveOpts: { platform: 'linux', sshpassAvailable: false },
    }),
    (err) => err instanceof ProcessError && err.exitCode === 255 && err.stderr === 'Permission denied',
  );
  assert.equal(fs.existsSync(capturedAskpassPath), false, 'askpass helper cleaned up on failure');
}

// 10. The materialized askpass script never inlines the plaintext password.
{
  const probePath = path.join(os.tmpdir(), `moss-askpass-probe-${process.pid}.sh`);
  const runner = async (_bin, opts) => {
    const body = fs.readFileSync(opts.env.SSH_ASKPASS, 'utf-8');
    assert.ok(!body.includes('sunrise'), 'password must not be written into the helper body');
    assert.match(body, new RegExp(SSH_PASSWORD_ENV_VAR), 'helper reads the password from its env var');
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  await runSsh({ host: '203.0.113.10', password: 'sunrise' }, ['root@203.0.113.10', 'true'], {
    runner,
    resolveOpts: { platform: 'linux', sshpassAvailable: false, askpassPath: probePath },
  });
  assert.equal(fs.existsSync(probePath), false);
}

console.log('[PASS] ssh-invocation: resolver bin/args/env decision + keyPath tilde expansion + askpass lifecycle');
