import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SafeCwdSource = 'cwd' | 'PWD' | 'cwd-fallback';

export interface SafeCwdResult {
  cwd: string;
  source: SafeCwdSource;
}

interface SafeCwdFunction {
  (): string;
  __dmossSafeCwd?: true;
  __dmossOriginalCwd?: () => string;
}

let lastFallback: SafeCwdResult | null = null;

function accessibleAbsoluteDirectory(candidate: string | undefined): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
    return path.normalize(candidate);
  } catch {
    return null;
  }
}

function fallbackCwd(env: NodeJS.ProcessEnv): SafeCwdResult {
  const pwd = accessibleAbsoluteDirectory(env.PWD);
  if (pwd) return { cwd: pwd, source: 'PWD' };
  return { cwd: os.homedir(), source: 'cwd-fallback' };
}

export function installSafeProcessCwd(env: NodeJS.ProcessEnv = process.env): void {
  const current = process.cwd as SafeCwdFunction;
  if (current.__dmossSafeCwd) return;

  const originalCwd = process.cwd.bind(process);
  const safeCwd: SafeCwdFunction = (() => {
    try {
      const cwd = originalCwd();
      lastFallback = null;
      return cwd;
    } catch {
      lastFallback = fallbackCwd(env);
      return lastFallback.cwd;
    }
  }) as SafeCwdFunction;
  safeCwd.__dmossSafeCwd = true;
  safeCwd.__dmossOriginalCwd = originalCwd;
  process.cwd = safeCwd;
}

export function resolveSafeCwd(env: NodeJS.ProcessEnv = process.env): SafeCwdResult {
  try {
    const cwd = process.cwd();
    if (lastFallback?.cwd === cwd) return lastFallback;
    return { cwd, source: 'cwd' };
  } catch {
    return fallbackCwd(env);
  }
}

export function safeProcessCwd(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSafeCwd(env).cwd;
}

export function resolvePathFromSafeCwd(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(safeProcessCwd(env), value);
}
