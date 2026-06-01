import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';

function colorEnabled(): boolean {
  if (process.env.NO_COLOR || process.env.DMOSS_NO_COLOR === '1') return false;
  if (!process.stderr.isTTY && !process.stdout.isTTY) return false;
  return true;
}

export const ui = {
  bold: (s: string) => (colorEnabled() ? pc.bold(s) : s),
  dim: (s: string) => (colorEnabled() ? pc.dim(s) : s),
  green: (s: string) => (colorEnabled() ? pc.green(s) : s),
  yellow: (s: string) => (colorEnabled() ? pc.yellow(s) : s),
  cyan: (s: string) => (colorEnabled() ? pc.cyan(s) : s),
  gray: (s: string) => (colorEnabled() ? pc.gray(s) : s),
};

export function label(name: string): string {
  return ui.dim(`${name}:`);
}

export function compactPath(value: string): string {
  const home = os.homedir();
  const normalized = path.resolve(value);
  if (normalized === home) return '~';
  if (normalized.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, normalized)}`;
  }
  return normalized;
}

export function statusDot(kind: 'ok' | 'warn' | 'info' = 'info'): string {
  if (kind === 'ok') return ui.green('•');
  if (kind === 'warn') return ui.yellow('•');
  return ui.cyan('•');
}
