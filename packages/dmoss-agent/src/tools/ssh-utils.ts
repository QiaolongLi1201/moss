import type { DeviceSshConfig } from './device-ssh.js';
import { ProcessError } from '../utils/run-process.js';

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
      ? 'Required SSH helper "sshpass" was not found. sshpass is not standard on Windows; use key-based auth with DMOSS_DEVICE_KEY, install sshpass in WSL, or run D-Moss from an environment that provides sshpass.'
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
    parts.push('-i', config.keyPath);
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
