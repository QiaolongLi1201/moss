import * as readline from 'node:readline';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { normalizeSafetyModeConfig, type ConfigApprovalPolicy } from './config.js';

export type CliSafetyMode = 'read-only' | 'workspace-write' | 'full-access';

type AskUser = (question: string) => Promise<string>;

let interactiveAsker: AskUser | null = null;

export interface CliToolApprovalOptions {
  approvalPolicy?: ConfigApprovalPolicy;
  trustedTools?: readonly string[];
  deniedTools?: readonly string[];
}

export interface CliToolApprovalPreview {
  toolName: string;
  sideEffect: ToolSideEffectClass;
  safetyMode: CliSafetyMode;
  inputPreview: string;
  decisionContext: string;
  requiresApproval: boolean;
  trusted: boolean;
  denied: boolean;
  autoApproved: boolean;
}

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

function hasAutoApproval(env: NodeJS.ProcessEnv, options: CliToolApprovalOptions): boolean {
  return options.approvalPolicy === 'never' ||
    env.DMOSS_CLI_AUTO_APPROVE === '1' ||
    env.DMOSS_AUTO_APPROVE === '1';
}

export function describeCliToolApproval(
  request: ToolApprovalRequest,
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
  options: CliToolApprovalOptions = {},
): CliToolApprovalPreview {
  const sideEffect = inferSideEffectClass(request.tool);
  const denied = new Set(options.deniedTools ?? []).has(request.tool.name);
  const trusted = new Set(options.trustedTools ?? []).has(request.tool.name);
  const autoApprovalConfigured = hasAutoApproval(env, options);
  const allowedBySafety = isAllowedInMode(mode, sideEffect);
  const requiresApproval = needsApproval(request.tool, sideEffect);
  const autoApproved = !denied && allowedBySafety && requiresApproval && autoApprovalConfigured;
  let decisionContext = 'readonly tool; approval is not required';

  if (denied) {
    decisionContext = 'blocked by configured deniedTools';
  } else if (!allowedBySafety) {
    decisionContext = `blocked by ${mode} safety mode`;
  } else if (requiresApproval && trusted) {
    decisionContext = 'trusted by configured trustedTools';
  } else if (requiresApproval && autoApproved) {
    decisionContext = 'auto-approved by approval policy after safety checks';
  } else if (requiresApproval) {
    decisionContext = `${mode} safety mode allows ${sideEffect}, but approval is required`;
  }

  return {
    toolName: request.tool.name,
    sideEffect,
    safetyMode: mode,
    inputPreview: previewInput(request.input),
    decisionContext,
    requiresApproval,
    trusted,
    denied,
    autoApproved,
  };
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
  options: CliToolApprovalOptions = {},
): NonNullable<AgentHooks['onBeforeToolExec']> {
  const sessionTrustedTools = new Set<string>();

  return async (request: ToolApprovalRequest) => {
    const { tool } = request;
    const preview = describeCliToolApproval(request, mode, env, {
      ...options,
      trustedTools: [...(options.trustedTools ?? []), ...sessionTrustedTools],
    });
    if (preview.denied) {
      return {
        approved: false,
        reason: `Tool "${tool.name}" is blocked by configured deniedTools.`,
      };
    }
    if (!isAllowedInMode(mode, preview.sideEffect)) {
      return {
        approved: false,
        reason: `Tool "${tool.name}" is blocked by ${mode} safety mode (side effect: ${preview.sideEffect}).`,
      };
    }
    if (!preview.requiresApproval) return { approved: true };

    if (preview.trusted) {
      return { approved: true };
    }

    if (preview.autoApproved) {
      return { approved: true };
    }

    if (!process.stdin.isTTY) {
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" requires approval, but stdin is not interactive. ` +
          'Use `dmoss config set approvalPolicy never` or `dmoss config set trustedTools <tool>` only in a trusted workspace; ' +
          'DMOSS_CLI_AUTO_APPROVE=1 is also supported for one-off automation.',
      };
    }

    const prompt = [
      '',
      `[approval] ${preview.toolName}`,
      `side effect: ${preview.sideEffect}`,
      `policy: ${preview.decisionContext}`,
      'input:',
      preview.inputPreview,
      `Allow once, or always for this session? [y/a/N] `,
    ].join('\n');
    const answer = (await (interactiveAsker ?? defaultAskUser)(prompt)).trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
      sessionTrustedTools.add(tool.name);
      return { approved: true };
    }
    if (answer === 'y' || answer === 'yes') {
      return { approved: true };
    }
    return { approved: false, reason: `User denied ${tool.name}.` };
  };
}
