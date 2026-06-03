/**
 * Config-driven hooks — run user-defined shell commands on agent events to
 * automate workflows (format on write, lint gate, notify, audit-log).
 *
 * Hooks are declared in the dmoss config under `hooks`:
 *   {
 *     "hooks": {
 *       "PreToolUse":  [{ "matcher": "exec", "command": "./scripts/guard.sh", "blocking": true }],
 *       "PostToolUse": [{ "matcher": "write_file|apply_patch|move_file", "command": "npm run format" }],
 *       "SessionStart":[{ "command": "echo session started >> .moss.log" }]
 *     }
 *   }
 *
 * Each command receives a JSON payload on stdin and `MOSS_HOOK_EVENT` /
 * `MOSS_TOOL_NAME` / `MOSS_WORKSPACE` env vars. A blocking PreToolUse hook that
 * exits non-zero vetoes the tool call (its output becomes the block reason).
 * PostToolUse hooks are fire-and-forget side effects. These compose with — and
 * run before — the CLI's normal tool-approval flow.
 */

import { spawn } from 'node:child_process';
import type { ToolApprovalRequest, ToolApprovalDecision } from '../core/agent/agent-hooks.js';
import type { ToolCall, ToolResult } from '../core/tools/tool-types.js';
import type { HooksConfig, HookCommandConfig } from './config.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

const IS_WIN = process.platform === 'win32';
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

interface HookRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HookPayload {
  event: 'PreToolUse' | 'PostToolUse' | 'SessionStart';
  toolName?: string;
  input?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

function runHookCommand(
  command: string,
  payload: HookPayload,
  cwd: string,
  timeoutMs: number,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
    const args = IS_WIN ? ['/c', command] : ['-c', command];
    const env = safeChildEnv({
      LANG: process.env.LANG || 'en_US.UTF-8',
      MOSS_HOOK_EVENT: payload.event,
      MOSS_TOOL_NAME: payload.toolName ?? '',
      MOSS_WORKSPACE: cwd,
    });

    let child;
    try {
      child = spawn(shell, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: HookRunResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      finish({ exitCode: 124, stdout, stderr: `${stderr}\n[hook timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ exitCode: 1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      /* stdin may already be closed */
    }
  });
}

function toolNameMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function timeoutFor(hook: HookCommandConfig): number {
  return Math.max(1000, Number(hook.timeoutMs) || DEFAULT_HOOK_TIMEOUT_MS);
}

export interface ConfiguredHookCallbacks {
  /** PreToolUse → AgentHooks.onBeforeToolExec (undefined when no PreToolUse hooks). */
  onBeforeToolExec?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
  /** PostToolUse → AgentHooks.onToolResult (undefined when no PostToolUse hooks). */
  onToolResult?: (call: ToolCall, result: ToolResult) => void;
  /** Run all SessionStart hooks once. */
  runSessionStart: () => Promise<void>;
  /** True when any hook of any kind is configured. */
  hasHooks: boolean;
}

/**
 * Build AgentHooks-compatible callbacks from the config `hooks` section.
 * Returns no-op-ish callbacks (undefined where nothing is configured) so the
 * caller composes them with the normal approval flow without overhead.
 */
export function createConfiguredHookCallbacks(
  hooks: HooksConfig | undefined,
  opts: { workspaceDir: string },
): ConfiguredHookCallbacks {
  const pre = hooks?.PreToolUse ?? [];
  const post = hooks?.PostToolUse ?? [];
  const sessionStart = hooks?.SessionStart ?? [];
  const cwd = opts.workspaceDir;

  const onBeforeToolExec =
    pre.length === 0
      ? undefined
      : async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
          for (const hook of pre) {
            if (!toolNameMatches(hook.matcher, request.tool.name)) continue;
            const blocking = hook.blocking !== false;
            const r = await runHookCommand(
              hook.command,
              { event: 'PreToolUse', toolName: request.tool.name, input: request.input },
              cwd,
              timeoutFor(hook),
            );
            if (blocking && r.exitCode !== 0) {
              const reason = (r.stderr || r.stdout || `hook exited ${r.exitCode}`).trim().slice(0, 500);
              return { approved: false, reason: `Blocked by PreToolUse hook: ${reason}` };
            }
          }
          return { approved: true };
        };

  const onToolResult =
    post.length === 0
      ? undefined
      : (call: ToolCall, result: ToolResult): void => {
          for (const hook of post) {
            if (!toolNameMatches(hook.matcher, call.name)) continue;
            void runHookCommand(
              hook.command,
              {
                event: 'PostToolUse',
                toolName: call.name,
                input: call.input,
                result: result.content,
                isError: Boolean(result.isError),
              },
              cwd,
              timeoutFor(hook),
            ).then((r) => {
              if (r.exitCode !== 0) {
                process.stderr.write(
                  `[hooks] PostToolUse (${call.name}) exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`,
                );
              }
            });
          }
        };

  const runSessionStart = async (): Promise<void> => {
    for (const hook of sessionStart) {
      const r = await runHookCommand(hook.command, { event: 'SessionStart' }, cwd, timeoutFor(hook));
      if (r.exitCode !== 0) {
        process.stderr.write(
          `[hooks] SessionStart exited ${r.exitCode}: ${(r.stderr || '').trim().slice(0, 200)}\n`,
        );
      }
    }
  };

  return {
    onBeforeToolExec,
    onToolResult,
    runSessionStart,
    hasHooks: pre.length + post.length + sessionStart.length > 0,
  };
}
