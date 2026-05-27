import type { DeviceSshConfig } from './device-ssh.js';

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
