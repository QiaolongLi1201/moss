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

  parts.push('-p', String(port), `${user}@${config.host}`, shellEscape(remoteCmd));
  return parts;
}
