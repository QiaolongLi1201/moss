/**
 * Background command execution for the Agent.
 *
 * The built-in `exec` tool runs synchronously and is killed on timeout, so it
 * cannot start a long-lived process — a dev server, a file watcher, a
 * `ros2 launch`, a build in `--watch` mode. These tools fill that gap with an
 * in-process registry of detached child processes:
 *
 *   - `exec_background` — start a command, return a handle, capture its output.
 *   - `exec_logs`       — read status + buffered output (or list all when no id).
 *   - `exec_stop`       — terminate a background command (group-kill on POSIX).
 *
 * Handles are process-local: they live for the agent process lifetime. Commands
 * run with cwd set to the workspace and pass through the same dangerous-command
 * guard as `exec`; hosts still enforce approval via `AgentHooks.onBeforeToolExec`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';

const IS_WIN = process.platform === 'win32';

/** Max buffered output retained per background process (bytes). */
const MAX_BUFFER = 256 * 1024;
/** Safety cap on concurrently tracked background processes. */
const MAX_PROCS = 32;
/** Default window (ms) to watch a freshly started process for an immediate crash. */
const DEFAULT_SETTLE_MS = 1200;

type BackgroundStatus = 'running' | 'exited' | 'killed' | 'error';

interface BackgroundProc {
  id: string;
  command: string;
  label?: string;
  child: ChildProcess;
  pid?: number;
  status: BackgroundStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  buffer: string;
  errorMessage?: string;
}

const registry = new Map<string, BackgroundProc>();
let counter = 0;

/** Test-only: clear the registry (does not kill processes). */
export function clearBackgroundRegistryForTests(): void {
  registry.clear();
  counter = 0;
}

function appendOutput(proc: BackgroundProc, chunk: string): void {
  proc.buffer += chunk;
  if (proc.buffer.length > MAX_BUFFER) {
    proc.buffer = proc.buffer.slice(proc.buffer.length - MAX_BUFFER);
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  // Drop a trailing empty element from a final newline so the tail count is honest.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function killProc(proc: BackgroundProc): void {
  const pid = proc.child.pid;
  try {
    if (IS_WIN && pid) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      proc.child.kill();
    } else if (pid) {
      process.kill(-pid, 'SIGTERM');
    } else {
      proc.child.kill('SIGTERM');
    }
  } catch {
    try {
      proc.child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

function describe(proc: BackgroundProc): string {
  const age = Math.round((( proc.endedAt ?? Date.now()) - proc.startedAt) / 1000);
  const tag = proc.label ? ` "${proc.label}"` : '';
  const exit =
    proc.status === 'running'
      ? ''
      : proc.status === 'error'
        ? ` (error: ${proc.errorMessage ?? 'unknown'})`
        : ` (exit ${proc.exitCode ?? '?'}${proc.signal ? `, signal ${proc.signal}` : ''})`;
  return `${proc.id}${tag} [${proc.status}${exit}] pid=${proc.pid ?? '?'} age=${age}s :: ${proc.command}`;
}

export const execBackgroundTool: Tool = {
  name: 'exec_background',
  description:
    'Start a shell command in the background (a server, watcher, or other long-running process) and return a handle id. ' +
    'Unlike exec, it does not block: use exec_logs to read its output and exec_stop to terminate it. ' +
    'Briefly watches the process after start so an immediate crash is reported inline.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Spawns a detached host process. Host must enforce approval via AgentHooks.onBeforeToolExec.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run in the background' },
      label: { type: 'string', description: 'Optional human-readable label for the process' },
      settle_ms: {
        type: 'number',
        description: `Time to watch for an immediate crash before returning (default ${DEFAULT_SETTLE_MS}, max 10000)`,
      },
    },
    required: ['command'],
  },
  async execute(input, ctx: ToolContext) {
    const command = String(input.command ?? '').trim();
    if (!command) return 'Error: command is required';

    const danger = isCommandDangerous(command);
    if (danger.blocked) return `Command blocked: ${danger.reason}`;

    const live = [...registry.values()].filter((p) => p.status === 'running').length;
    if (live >= MAX_PROCS) {
      return `Error: too many background processes (${live}/${MAX_PROCS}). Stop one with exec_stop first.`;
    }

    const settleMs = Math.min(Math.max(0, Number(input.settle_ms) || DEFAULT_SETTLE_MS), 10_000);
    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];

    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ctx.workspaceDir,
        env: safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' }),
        detached: !IS_WIN,
        windowsHide: true,
      });
    } catch (err) {
      return `Error starting background command: ${err instanceof Error ? err.message : String(err)}`;
    }

    const id = `bg_${++counter}`;
    const proc: BackgroundProc = {
      id,
      command,
      label: typeof input.label === 'string' ? input.label : undefined,
      child,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: Date.now(),
      buffer: '',
    };
    registry.set(id, proc);

    child.stdout?.on('data', (c: Buffer) => appendOutput(proc, c.toString()));
    child.stderr?.on('data', (c: Buffer) => appendOutput(proc, c.toString()));

    const settled = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.on('exit', (code, signal) => {
        proc.status = signal ? 'killed' : 'exited';
        proc.exitCode = code;
        proc.signal = signal;
        proc.endedAt = Date.now();
        finish();
      });
      child.on('error', (err) => {
        proc.status = 'error';
        proc.errorMessage = err.message;
        proc.endedAt = Date.now();
        finish();
      });
      const timer = setTimeout(finish, settleMs);
      if (typeof timer.unref === 'function') timer.unref();
      ctx.abortSignal?.addEventListener('abort', finish, { once: true });
    });

    await settled;

    const head = tailLines(proc.buffer, 20);
    const outputSection = head ? `\n--- output so far ---\n${head}` : '';
    if (proc.status === 'running') {
      return `Started ${id} (pid ${proc.pid}). Still running after ${settleMs}ms. Use exec_logs("${id}") and exec_stop("${id}").${outputSection}`;
    }
    if (proc.status === 'error') {
      return `Background command ${id} failed to start: ${proc.errorMessage}${outputSection}`;
    }
    return `Background command ${id} exited immediately (exit ${proc.exitCode}${proc.signal ? `, signal ${proc.signal}` : ''}).${outputSection}`;
  },
};

export const execLogsTool: Tool = {
  name: 'exec_logs',
  description:
    'Read the status and recent output of a background command started by exec_background. ' +
    'Omit `id` to list all tracked background processes.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background process id (e.g. "bg_1"). Omit to list all.' },
      tail: { type: 'number', description: 'Number of trailing output lines to return (default 100, max 1000)' },
    },
  },
  async execute(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      if (registry.size === 0) return 'No background processes.';
      return [...registry.values()].map(describe).join('\n');
    }
    const proc = registry.get(id);
    if (!proc) return `Error: no background process with id "${id}". Use exec_logs (no id) to list them.`;
    const tail = Math.min(Math.max(1, Number(input.tail) || 100), 1000);
    const body = tailLines(proc.buffer, tail) || '(no output captured)';
    return `${describe(proc)}\n--- last ${tail} line(s) ---\n${body}`;
  },
};

export const execStopTool: Tool = {
  name: 'exec_stop',
  description: 'Stop a background command started by exec_background (terminates its process group on POSIX).',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background process id to stop (e.g. "bg_1")' },
    },
    required: ['id'],
  },
  async execute(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return 'Error: id is required';
    const proc = registry.get(id);
    if (!proc) return `Error: no background process with id "${id}".`;
    if (proc.status !== 'running') {
      return `${id} is already ${proc.status} (exit ${proc.exitCode ?? '?'}).`;
    }
    killProc(proc);
    return `Stopping ${id} (pid ${proc.pid}). Use exec_logs("${id}") to confirm it has exited.`;
  },
};

/** Background command lifecycle tools. */
export const backgroundExecTools: Tool[] = [execBackgroundTool, execLogsTool, execStopTool];
