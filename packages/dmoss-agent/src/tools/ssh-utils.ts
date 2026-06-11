import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DeviceSshConfig } from './device-ssh.js';
import { ProcessError, runProcess, type RunProcessResult } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Expand a leading `~` / `~/` in a path to the user's home directory.
 * Mirrors the helpers in cli/attachments.ts and safety/sandbox-paths.ts —
 * kept local so host-neutral tools don't import CLI code. Only a leading
 * tilde is expanded (an embedded `~` is a legitimate filename character).
 *
 * @internal
 */
export function expandHomePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function isMissingExecutableError(err: unknown, executable: string): boolean {
  const e = err as { code?: unknown; path?: unknown; syscall?: unknown };
  if (e?.code !== 'ENOENT') return false;
  const path = typeof e.path === 'string' ? e.path : '';
  return !path || path === executable;
}

export function formatMissingSshExecutable(executable: string): string {
  if (executable === 'sshpass') {
    return process.platform === 'win32'
      ? 'Required SSH helper "sshpass" was not found. sshpass is not standard on Windows; use key-based auth with DMOSS_DEVICE_KEY, install sshpass in WSL, or run Moss from an environment that provides sshpass.'
      : 'Required SSH helper "sshpass" was not found. Install sshpass, or use key-based auth with DMOSS_DEVICE_KEY.';
  }
  return process.platform === 'win32'
    ? 'Required SSH executable "ssh" was not found. Install the OpenSSH Client optional feature in Windows, or install it with winget, then retry.'
    : 'Required SSH executable "ssh" was not found. Install OpenSSH client, then retry.';
}

export function missingSshExecutableProcessError(
  err: unknown,
  executable: string,
): ProcessError | null {
  if (!isMissingExecutableError(err, executable)) return null;
  return new ProcessError(127, '', formatMissingSshExecutable(executable));
}

/**
 * Convert an SSH child-process failure into the Error a tool must THROW.
 * Returns null for non-SSH errors (caller wraps those as DmossError).
 *
 * Failures must THROW so the pipeline marks the result isError (UI "err",
 * skill evidence failed:true). Returning failure text as a normal result
 * rendered SSH failures as successful tool calls — past P0, fixed in
 * device-diagnostics and (later) device-ros2; use this helper for every
 * SSH-backed tool so the class stays fixed.
 */
export function sshFailureToError(err: unknown, executable: string): Error | null {
  const missingExecutable = missingSshExecutableProcessError(err, executable);
  if (missingExecutable) return new Error(missingExecutable.stderr);
  if (err instanceof ProcessError) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return new Error(output || err.message);
  }
  return null;
}

export function buildSshCommand(
  config: DeviceSshConfig,
  remoteCmd: string,
  connectTimeout = 10,
): string[] {
  const user = config.user || 'root';
  const port = config.port || 22;
  const parts = ['-o', 'StrictHostKeyChecking=no', '-o', `ConnectTimeout=${connectTimeout}`];

  if (config.keyPath) {
    // Expand a leading ~ (passed via --key or DMOSS_DEVICE_KEY). ssh itself does
    // NOT expand ~ in -i; the shell would have done it, but we spawn shell-less,
    // so an unexpanded "~/.ssh/id_rsa" reaches ssh verbatim and silently fails.
    parts.push('-i', expandHomePath(config.keyPath));
  }

  // The remote command must be passed RAW. We spawn ssh without a local
  // shell, so no local escaping is needed, and ssh hands the string to the
  // remote shell for parsing. Wrapping it in quotes here (the old behavior)
  // made the remote shell treat the WHOLE command as one program name —
  // `bash: uname -n || hostname: No such file or directory` — which silently
  // broke every multi-word command in every SSH-backed tool. Escaping belongs
  // to arguments INSIDE the remote command (shellEscape on paths), never to
  // the command as a whole.
  parts.push('-p', String(port), `${user}@${config.host}`, remoteCmd);
  return parts;
}

/**
 * Env var the SSH_ASKPASS helper reads the password from. The plaintext rides
 * in the child env (never in argv, never written into the helper script body).
 *
 * @internal
 */
export const SSH_PASSWORD_ENV_VAR = 'DMOSS_SSH_PASSWORD';

/** OpenSSH options that force a single password prompt and skip pubkey. */
const PASSWORD_AUTH_SSH_OPTS = [
  '-o',
  'PreferredAuthentications=password,keyboard-interactive',
  '-o',
  'NumberOfPasswordPrompts=1',
  '-o',
  'PubkeyAuthentication=no',
];

/** Resolved SSH child invocation: which binary, argv, and child env to use. */
export interface SshInvocation {
  bin: string;
  args: string[];
  /** Child-env overrides to merge on top of safeChildEnv. */
  env: Record<string, string>;
  /**
   * Path the SSH_ASKPASS helper script must be written to before spawning, and
   * deleted after. Set only on the native-ssh password path; undefined for the
   * sshpass and key/no-auth paths.
   */
  askpass?: string;
}

export interface ResolveSshInvocationOptions {
  /** Defaults to process.platform — overridable so the win32 path is testable on POSIX. */
  platform?: NodeJS.Platform;
  /** Defaults to a real `sshpass -h` PATH probe — overridable for tests. */
  sshpassAvailable?: boolean;
  /** Path the askpass helper WILL be written to. Defaults to a per-call temp path. */
  askpassPath?: string;
}

let sshpassAvailableCache: boolean | undefined;

/** Probe once whether `sshpass` resolves on PATH (cached for the process). */
function detectSshpass(): boolean {
  if (sshpassAvailableCache !== undefined) return sshpassAvailableCache;
  try {
    const res = spawnSync('sshpass', ['-h'], { stdio: 'ignore', windowsHide: true });
    // ENOENT → res.error set; any spawn that resolved the binary (even a non-zero
    // help exit) proves it's installed.
    sshpassAvailableCache = !res.error;
  } catch {
    sshpassAvailableCache = false;
  }
  return sshpassAvailableCache;
}

/**
 * Decide how to invoke ssh for a given config — PURE (no I/O, no temp files).
 *
 * Three paths:
 *  - no password → plain `ssh` (key/agent auth), args & env untouched.
 *  - password + sshpass available on a non-win32 host → `sshpass -e ssh …`
 *    with `SSHPASS` in the env (the long-standing POSIX behavior).
 *  - password otherwise (Windows, or POSIX without sshpass) → native OpenSSH
 *    driven by an `SSH_ASKPASS` helper. The password is supplied via the
 *    {@link SSH_PASSWORD_ENV_VAR} child-env var, and `-o PreferredAuthentications=…`
 *    forces password auth so a missing key doesn't pre-empt the prompt. The
 *    `askpass` field tells the runtime where to materialize the helper script.
 *
 * `platform` and `sshpassAvailable` are injectable so the win32 path is
 * assertable on any OS.
 *
 * @beta
 */
export function resolveSshInvocation(
  config: DeviceSshConfig,
  sshArgs: string[],
  opts: ResolveSshInvocationOptions = {},
): SshInvocation {
  if (!config.password) {
    return { bin: 'ssh', args: sshArgs, env: {} };
  }

  const platform = opts.platform ?? process.platform;
  const sshpassAvailable = opts.sshpassAvailable ?? (platform !== 'win32' && detectSshpass());

  // sshpass is POSIX-only and not standard on Windows; use it only off-win32
  // when it actually resolves.
  if (platform !== 'win32' && sshpassAvailable) {
    return {
      bin: 'sshpass',
      args: ['-e', 'ssh', ...sshArgs],
      env: { SSHPASS: config.password },
    };
  }

  // Native-OpenSSH password path via SSH_ASKPASS (Windows, or POSIX w/o sshpass).
  const askpass =
    opts.askpassPath ??
    path.join(os.tmpdir(), `moss-askpass-${process.pid}-${Date.now()}${platform === 'win32' ? '.cmd' : '.sh'}`);
  return {
    bin: 'ssh',
    args: [...PASSWORD_AUTH_SSH_OPTS, ...sshArgs],
    env: {
      [SSH_PASSWORD_ENV_VAR]: config.password,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      // Older OpenSSH only consulted SSH_ASKPASS when DISPLAY was set; harmless
      // on Windows and on OpenSSH builds that honor SSH_ASKPASS_REQUIRE alone.
      DISPLAY: process.env.DISPLAY || ':0',
    },
    askpass,
  };
}

/** Body of the SSH_ASKPASS helper — reads the password from env, never inlines it. */
function askpassScript(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // ssh runs the helper and reads its stdout; `echo` adds a trailing CRLF that
    // OpenSSH strips. `@echo off` keeps the command itself off stdout.
    return `@echo off\r\necho %${SSH_PASSWORD_ENV_VAR}%\r\n`;
  }
  return `#!/bin/sh\nprintf '%s\\n' "$${SSH_PASSWORD_ENV_VAR}"\n`;
}

/**
 * Run an ssh command for a device config, centralizing the sshpass / native-ssh
 * decision and the SSH_ASKPASS helper lifecycle. Every SSH-backed tool routes
 * through this so the password-auth behavior (and its Windows support) lives in
 * one place.
 *
 * The askpass helper is written to an owner-only 0700 temp file (it must be
 * executable for OpenSSH to run it), used, and deleted in a `finally` — the
 * plaintext password is passed to it via env, never written into the script
 * body or argv.
 *
 * @beta
 */
export async function runSsh(
  config: DeviceSshConfig,
  sshArgs: string[],
  runOpts: {
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    /** Injectable runner for tests (device-workspace precedent). */
    runner?: typeof runProcess;
    /**
     * Override platform / sshpass detection — a test-only seam so the
     * native-ssh askpass path can be exercised on a box that has sshpass.
     * Production callers leave this unset (real platform + sshpass probe).
     */
    resolveOpts?: ResolveSshInvocationOptions;
  } = {},
): Promise<RunProcessResult> {
  const runner = runOpts.runner ?? runProcess;
  const invocation = resolveSshInvocation(config, sshArgs, runOpts.resolveOpts);
  const platform = runOpts.resolveOpts?.platform ?? process.platform;

  if (invocation.askpass) {
    fs.writeFileSync(invocation.askpass, askpassScript(platform), { mode: 0o700 });
  }
  try {
    return await runner(invocation.bin, {
      args: invocation.args,
      timeout: runOpts.timeout,
      maxBuffer: runOpts.maxBuffer,
      signal: runOpts.signal,
      env: safeChildEnv(invocation.env),
    });
  } finally {
    if (invocation.askpass) {
      try {
        fs.unlinkSync(invocation.askpass);
      } catch {
        /* helper already gone; nothing to clean up */
      }
    }
  }
}

/**
 * The ssh binary `runSsh` will spawn for this config — used by callers that
 * report the "missing executable" diagnostic after a failed run.
 *
 * @internal
 */
export function sshBinFor(config: DeviceSshConfig): string {
  return resolveSshInvocation(config, []).bin;
}
