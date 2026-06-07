import * as readline from 'node:readline';
import micromatch from 'micromatch';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { normalizeSafetyModeConfig, type ConfigApprovalPolicy } from './config.js';

export type CliSafetyMode = 'read-only' | 'workspace-write' | 'full-access';

type AskUser = (question: string) => Promise<string>;

let interactiveAsker: AskUser | null = null;

/** 交互模式（对齐 headless agent）：plan=只读规划 / default=正常审批 / acceptEdits=自动批准写入。TUI 经 Shift+Tab 切换。 */
export type CliInteractionMode = 'plan' | 'default' | 'acceptEdits';
let currentInteractionMode: CliInteractionMode = 'default';
export function setCliInteractionMode(mode: CliInteractionMode): void {
  currentInteractionMode = mode;
}
export function getCliInteractionMode(): CliInteractionMode {
  return currentInteractionMode;
}

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
  trustedPattern?: string;
  denied: boolean;
  deniedPattern?: string;
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

function stripPromptControlChars(value: string): string {
  return Array.from(value).filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('');
}

function cleanPromptText(value: string): string {
  return stripPromptControlChars(sanitizeSecrets(value))
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPromptValue(value: unknown, limit = 220): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = cleanPromptText(value);
  if (!cleaned) return undefined;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function compactInputValue(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = compactPromptValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

function patchPathSummary(input: Record<string, unknown>): string | undefined {
  const patch = typeof input.patch === 'string' ? input.patch : undefined;
  if (!patch) return undefined;
  const paths = Array.from(patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
    .map((match) => cleanPromptText(match[1] ?? ''))
    .filter(Boolean);
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];
  return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, +${paths.length - 3} more` : ''}`;
}

function approvalTargetSummary(toolName: string, input: Record<string, unknown>): string | undefined {
  const command = compactInputValue(input, ['command', 'cmd', 'shell_command']);
  if (command) return command;
  const source = compactInputValue(input, ['source', 'src']);
  const destination = compactInputValue(input, ['destination', 'dest', 'target']);
  if (source && destination) return `${source} -> ${destination}`;
  const patch = patchPathSummary(input);
  if (patch) return patch;
  const directTarget = compactInputValue(input, [
    'path',
    'file_path',
    'filepath',
    'file',
    'url',
    'uri',
    'href',
    'task',
    'description',
    'query',
    'id',
  ]);
  if (directTarget) return directTarget;
  return cleanPromptText(toolName);
}

function approvalActionSummary(preview: CliToolApprovalPreview, input: Record<string, unknown>): string {
  const toolName = preview.toolName;
  const hasCommand = compactInputValue(input, ['command', 'cmd', 'shell_command']) !== undefined;
  if (hasCommand && preview.sideEffect === 'device_mutation') return 'run a command on the device';
  if (hasCommand && /background/i.test(toolName)) return 'start a background command';
  if (hasCommand) return 'run a local command';
  if (preview.sideEffect === 'memory_write') return 'update memory';
  if (preview.sideEffect === 'runtime_state') return 'change session state';
  if (preview.sideEffect === 'subagent') return 'start a sub-agent task';
  if (preview.sideEffect === 'credential') return 'use credentials';
  if (preview.sideEffect === 'external_message') return 'send an external message';
  if (preview.sideEffect === 'device_mutation') return 'change the connected device';
  if (/apply_patch|patch/i.test(toolName)) return 'apply a patch';
  if (/write|create/i.test(toolName)) return 'write a file';
  if (/edit|replace|update/i.test(toolName)) return 'edit a file';
  if (/delete|remove/i.test(toolName)) return 'delete something';
  return `use ${cleanPromptText(toolName)}`;
}

function approvalScopeSummary(preview: CliToolApprovalPreview, input: Record<string, unknown>): string {
  const hasCommand = compactInputValue(input, ['command', 'cmd', 'shell_command']) !== undefined;
  switch (preview.sideEffect) {
    case 'local_write':
      return hasCommand ? 'workspace command' : 'workspace file change';
    case 'device_mutation':
      return 'connected device';
    case 'memory_write':
      return 'Moss memory';
    case 'runtime_state':
      return 'current session';
    case 'subagent':
      return 'sub-agent';
    case 'credential':
      return 'credentials';
    case 'external_message':
      return 'external message';
    case 'readonly':
      return 'read-only';
  }
}

export function renderCliApprovalPrompt(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
): string {
  const target = approvalTargetSummary(preview.toolName, input);
  const lines = [
    '',
    `Moss wants to ${approvalActionSummary(preview, input)}`,
    target ? `  ${target}` : '',
    `Scope: ${approvalScopeSummary(preview, input)}`,
    'Allow once, allow this tool for the session, or deny. [y/a/N] ',
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function hasAutoApproval(env: NodeJS.ProcessEnv, options: CliToolApprovalOptions): boolean {
  return options.approvalPolicy === 'never' ||
    env.DMOSS_CLI_AUTO_APPROVE === '1' ||
    env.DMOSS_AUTO_APPROVE === '1';
}

function findConfiguredToolPattern(toolName: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => (
    pattern === toolName ||
    micromatch.isMatch(toolName, pattern, {
      contains: false,
      dot: true,
      nocase: false,
      noextglob: true,
      nonegate: true,
    })
  ));
}

export function describeCliToolApproval(
  request: ToolApprovalRequest,
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
  options: CliToolApprovalOptions = {},
): CliToolApprovalPreview {
  const sideEffect = inferSideEffectClass(request.tool);
  const deniedPattern = findConfiguredToolPattern(request.tool.name, options.deniedTools ?? []);
  const trustedPattern = findConfiguredToolPattern(request.tool.name, options.trustedTools ?? []);
  const denied = deniedPattern !== undefined;
  const trusted = trustedPattern !== undefined;
  const autoApprovalConfigured = hasAutoApproval(env, options);
  const allowedBySafety = isAllowedInMode(mode, sideEffect);
  const requiresApproval = needsApproval(request.tool, sideEffect);
  const autoApproved = !denied && allowedBySafety && requiresApproval && autoApprovalConfigured;
  let decisionContext = 'readonly tool; approval is not required';

  if (denied) {
    decisionContext = `blocked by configured deniedTools (${deniedPattern})`;
  } else if (!allowedBySafety) {
    decisionContext = `blocked by ${mode} safety mode`;
  } else if (requiresApproval && trusted) {
    decisionContext = `trusted by configured trustedTools (${trustedPattern})`;
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
    trustedPattern,
    denied,
    deniedPattern,
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
    const interaction = getCliInteractionMode();
    if (interaction === 'plan' && preview.sideEffect !== 'readonly') {
      return {
        approved: false,
        reason: `计划模式(plan)：先产出实施计划，暂不执行变更。按 Shift+Tab 切到 default / accept-edits 后再运行 "${tool.name}"。`,
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

    if (interaction === 'acceptEdits') {
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

    const prompt = renderCliApprovalPrompt(preview, request.input);
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
