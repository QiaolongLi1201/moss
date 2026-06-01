import * as readline from 'node:readline';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { normalizeSafetyModeConfig } from './config.js';

export type CliSafetyMode = 'read-only' | 'workspace-write' | 'full-access';

type AskUser = (question: string) => Promise<string>;

let interactiveAsker: AskUser | null = null;

export function setCliApprovalAsker(asker: AskUser | null): void {
  interactiveAsker = asker;
}

export function resolveCliSafetyMode(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliSafetyMode {
  if (argv.includes('--read-only')) return 'read-only';
  if (argv.includes('--workspace-write')) return 'workspace-write';
  if (argv.includes('--full-access')) return 'full-access';
  const raw = (env.DMOSS_SAFETY_MODE || env.DMOSS_CLI_SAFETY_MODE || '').toLowerCase().trim();
  const envMode = normalizeSafetyModeConfig(raw);
  if (envMode) return envMode;
  return 'workspace-write';
}

function inferSideEffectClass(tool: Tool): ToolSideEffectClass {
  const explicit = tool.metadata?.sideEffectClass;
  if (explicit) return explicit;
  if (/(^|_)(read|list|search|get|status|diagnose|inspect|describe)(_|$)/i.test(tool.name)) {
    return 'readonly';
  }
  if (/(^|_)(write|delete|remove|patch|exec|run|install|start|stop|restart|send|post|create|update|set)(_|$)/i.test(tool.name)) {
    return 'local_write';
  }
  return 'readonly';
}

function isAllowedInMode(mode: CliSafetyMode, sideEffect: ToolSideEffectClass): boolean {
  if (sideEffect === 'readonly') return true;
  if (mode === 'read-only') return false;
  if (mode === 'workspace-write') {
    return sideEffect === 'local_write' ||
      sideEffect === 'memory_write' ||
      sideEffect === 'runtime_state' ||
      sideEffect === 'subagent';
  }
  return true;
}

function needsApproval(tool: Tool, sideEffect: ToolSideEffectClass): boolean {
  return sideEffect !== 'readonly' || tool.metadata?.planMode === 'requires_user_confirmation';
}

function previewInput(input: Record<string, unknown>): string {
  const raw = sanitizeSecrets(JSON.stringify(input, null, 2));
  return raw.length > 1200 ? `${raw.slice(0, 1200)}\n... [truncated ${raw.length} chars]` : raw;
}

async function defaultAskUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = (answer: string) => {
      rl.close();
      resolve(answer);
    };
    rl.once('SIGINT', () => finish(''));
    rl.question(question, finish);
  });
}

export function createCliToolApprovalHook(
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<AgentHooks['onBeforeToolExec']> {
  return async ({ tool, input }: ToolApprovalRequest) => {
    const sideEffect = inferSideEffectClass(tool);
    if (!isAllowedInMode(mode, sideEffect)) {
      return {
        approved: false,
        reason: `Tool "${tool.name}" is blocked by ${mode} safety mode (side effect: ${sideEffect}).`,
      };
    }
    if (!needsApproval(tool, sideEffect)) return { approved: true };

    if (env.DMOSS_CLI_AUTO_APPROVE === '1' || env.DMOSS_AUTO_APPROVE === '1') {
      return { approved: true };
    }

    if (!process.stdin.isTTY) {
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" requires approval, but stdin is not interactive. ` +
          'Set DMOSS_CLI_AUTO_APPROVE=1 only in a trusted workspace.',
      };
    }

    const prompt = [
      '',
      `[approval] ${tool.name} (${sideEffect}) wants to run:`,
      previewInput(input),
      `Allow once? [y/N] `,
    ].join('\n');
    const answer = (await (interactiveAsker ?? defaultAskUser)(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes'
      ? { approved: true }
      : { approved: false, reason: `User denied ${tool.name}.` };
  };
}
