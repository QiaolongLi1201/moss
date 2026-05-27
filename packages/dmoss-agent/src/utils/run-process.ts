/**
 * Async child process runner — non-blocking replacement for execFileSync/execSync.
 *
 * Uses `child_process.spawn` so the Node event loop is never blocked.
 * Supports AbortSignal (kills child on abort) and timeout (kills child on expiry).
 *
 * Drop-in for device tools that previously used `execFileSync`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunProcessOptions {
  args: string[];
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ProcessError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(exitCode: number, stdout: string, stderr: string) {
    super(`Process exited with code ${exitCode}`);
    this.name = 'ProcessError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function runProcess(cmd: string, opts: RunProcessOptions): Promise<RunProcessResult> {
  if (opts.signal?.aborted) {
    return Promise.reject(new ProcessError(1, '', 'Process aborted before start'));
  }

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
      cwd: opts.cwd,
    };

    const child = spawn(cmd, opts.args, spawnOpts);

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals = 'SIGKILL') => {
      if (killed) return;
      killed = true;
      try { child.kill(signal); } catch { /* already dead */ }
    };

    if (opts.timeout && opts.timeout > 0) {
      timeoutId = setTimeout(() => kill(), opts.timeout);
    }

    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < (opts.maxBuffer ?? DEFAULT_MAX_BUFFER)) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < (opts.maxBuffer ?? DEFAULT_MAX_BUFFER)) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
      } else {
        reject(new ProcessError(exitCode, stdout, stderr));
      }
    });
  });
}
