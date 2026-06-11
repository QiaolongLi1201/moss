import * as path from 'node:path';
import * as readline from 'node:readline';
import micromatch from 'micromatch';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { normalizeSafetyModeConfig, type ConfigApprovalPolicy } from './config.js';
import { buildApprovalDetailLines, type ApprovalDetailContext } from './approval-detail.js';

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
  workspaceDir?: string;
  /** Connected board target, shown in device-mutation approval cards. */
  device?: { host: string; user?: string; port?: number } | null;
  /**
   * Live board-mode signal. When true, /connect has put the session in BOARD
   * MODE: device-scoped + workspace tools are auto-approved and not blocked by
   * the base workspace-write floor, so connected-board ops are frictionless.
   * A getter (not a boolean) so the hook — created once — observes /connect and
   * /disconnect flipping the flag without being recreated. read-only mode is
   * still honored; the hard isCommandDangerous block stays inside the tools.
   */
  boardMode?: () => boolean;
  /**
   * Live safety-mode override (getter). When it returns a mode, that mode
   * replaces the base mode for the current call — lets an in-session escalation
   * (/yolo) widen the allowlist without recreating the hook. Returns undefined
   * to use the base mode.
   */
  safetyModeOverride?: () => CliSafetyMode | undefined;
  /**
   * Live "no per-call prompt" signal (getter). When true, tools ALLOWED by the
   * (possibly overridden) safety mode run without an interactive prompt. The
   * user opted into this (--full-access / /yolo / approvalPolicy never); it
   * never bypasses isAllowedInMode (read-only still blocks all mutation), the
   * isCommandDangerous floor, or deniedTools.
   */
  autoApprove?: () => boolean;
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
  /** Auto-approved because the session is in board mode (device/workspace tool). */
  boardAutoApproved: boolean;
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

function tokenizeReadonlyShellCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '$') return undefined;

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ';' || char === '&' || char === '|' || char === '<' || char === '>' || char === '`') {
      return undefined;
    }

    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }

    token += char;
  }

  if (escaping || quote) return undefined;
  if (token) tokens.push(token);
  return tokens.length > 0 ? tokens : undefined;
}

function hasUnsafePathArgument(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    if (!token || token === '--') return false;
    const normalized = token.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) return true;
    if (normalized.startsWith('/') || normalized.startsWith('~')) return true;
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return true;
    if (token.startsWith('-')) {
      return /=(?:\/|~|[A-Za-z]:[\\/])/.test(token) || token.includes('../');
    }
    return false;
  });
}

function isReadonlyTail(tokens: readonly string[]): boolean {
  return !tokens.some((token) => token === '-f' || token === '--follow' || token.startsWith('--follow='));
}

function isReadonlySed(tokens: readonly string[]): boolean {
  if (tokens.some((token) => token === '-i' || token.startsWith('-i') || token === '--in-place' || token.startsWith('--in-place='))) return false;
  return tokens.some((token) => token === '-n' || token === '--quiet' || token === '--silent' || (/^-[A-Za-z]*n[A-Za-z]*$/.test(token)));
}

function isReadonlyFind(tokens: readonly string[]): boolean {
  const mutatingPredicates = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
  return tokens.every((token) => !mutatingPredicates.has(token));
}

function isReadonlyGit(tokens: readonly string[]): boolean {
  const subcommand = tokens[1];
  if (!subcommand) return false;
  if (subcommand === 'branch') {
    const mutatingOptions = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream']);
    return tokens.slice(2).every((token) => token.startsWith('-') && !mutatingOptions.has(token));
  }
  if (subcommand === 'remote') {
    return tokens.length === 2 || (tokens.length === 3 && tokens[2] === '-v');
  }
  return new Set([
    'status',
    'diff',
    'log',
    'show',
    'rev-parse',
    'ls-files',
    'grep',
    'blame',
    'describe',
  ]).has(subcommand);
}

function isReadonlyExecCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (isCommandDangerous(command).blocked) return false;
  const tokens = tokenizeReadonlyShellCommand(command);
  if (!tokens) return false;
  const commandName = tokens[0];
  if (!commandName || commandName.includes('/') || commandName.includes('\\')) return false;
  if (hasUnsafePathArgument(tokens.slice(1))) return false;

  if (commandName === 'git') return isReadonlyGit(tokens);
  if (commandName === 'tail') return isReadonlyTail(tokens);
  if (commandName === 'sed') return isReadonlySed(tokens);
  if (commandName === 'find') return isReadonlyFind(tokens);

  return new Set([
    'pwd',
    'ls',
    'tree',
    'cat',
    'head',
    'wc',
    'stat',
    'file',
    'du',
    'rg',
    'grep',
  ]).has(commandName);
}

function inferRequestSideEffectClass(request: ToolApprovalRequest): ToolSideEffectClass {
  const sideEffect = inferSideEffectClass(request.tool);
  if (request.tool.name === 'exec' && sideEffect === 'local_write' && isReadonlyExecCommand(request.input.command)) {
    return 'readonly';
  }
  return sideEffect;
}

/** Side effects board mode releases on top of the base mode's allowance. */
function isBoardScopedSideEffect(sideEffect: ToolSideEffectClass): boolean {
  return sideEffect === 'device_mutation' || sideEffect === 'local_write';
}

function isAllowedInMode(
  mode: CliSafetyMode,
  sideEffect: ToolSideEffectClass,
  boardMode = false,
): boolean {
  if (sideEffect === 'readonly') return true;
  if (mode === 'read-only') return false;
  // Board mode releases device/workspace tools so connected-board ops are
  // frictionless — but never in read-only (handled above): that is an explicit
  // user opt-in and stays safe even on a board. The hard isCommandDangerous
  // floor lives inside the tools, so it is unaffected.
  if (boardMode && isBoardScopedSideEffect(sideEffect)) return true;
  if (mode === 'workspace-write') {
    return sideEffect === 'local_write' ||
      sideEffect === 'memory_write' ||
      sideEffect === 'runtime_state' ||
      sideEffect === 'subagent' ||
      // MCP + browser tools (external_message) are PROMPTABLE in workspace-write
      // rather than hard-blocked: a user who configured an MCP server clearly
      // wants it, and the per-call approval prompt keeps each use consented.
      sideEffect === 'external_message';
  }
  return true;
}

function needsApproval(request: ToolApprovalRequest, sideEffect: ToolSideEffectClass): boolean {
  if (request.tool.metadata?.requiresApproval !== undefined) return request.tool.metadata.requiresApproval;
  if (request.tool.name === 'exec' && sideEffect === 'readonly') return false;
  return sideEffect !== 'readonly' || request.tool.metadata?.planMode === 'requires_user_confirmation';
}

function workspaceTrustRoot(workspaceDir: string | undefined): string {
  return path.resolve(workspaceDir || process.cwd());
}

function isWorkspaceTrustEligible(sideEffect: ToolSideEffectClass): boolean {
  return sideEffect === 'local_write';
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

function approvalAlwaysSummary(preview: CliToolApprovalPreview): string {
  if (isWorkspaceTrustEligible(preview.sideEffect)) return 'trust this workspace for the session';
  return 'allow this scope for the session';
}

export function renderCliApprovalPrompt(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  detailCtx: ApprovalDetailContext = {},
): string {
  const target = approvalTargetSummary(preview.toolName, input);
  // Decision-time detail: ± diff for file edits, action plan for device
  // mutations — so the user can decide without expanding anything.
  const detail = buildApprovalDetailLines(preview.toolName, preview.sideEffect, input, detailCtx);
  const lines = [
    '',
    `Moss wants to ${approvalActionSummary(preview, input)}`,
    target ? `  ${target}` : '',
    ...detail,
    `Scope: ${approvalScopeSummary(preview, input)}`,
    `Allow once, ${approvalAlwaysSummary(preview)}, or deny. [y/a/N] `,
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
  const sideEffect = inferRequestSideEffectClass(request);
  const deniedPattern = findConfiguredToolPattern(request.tool.name, options.deniedTools ?? []);
  const trustedPattern = findConfiguredToolPattern(request.tool.name, options.trustedTools ?? []);
  const denied = deniedPattern !== undefined;
  const trusted = trustedPattern !== undefined;
  const autoApprovalConfigured = hasAutoApproval(env, options);
  const boardMode = options.boardMode?.() === true;
  const allowedBySafety = isAllowedInMode(mode, sideEffect, boardMode);
  const requiresApproval = needsApproval(request, sideEffect);
  const autoApproved = !denied && allowedBySafety && requiresApproval && autoApprovalConfigured;
  // In board mode, device/workspace tools run without a per-call prompt — the
  // user already opted in by running /connect. (isCommandDangerous still blocks
  // inside the tool; deniedTools still wins via the !denied guard.)
  const boardAutoApproved =
    boardMode && !denied && allowedBySafety && requiresApproval && isBoardScopedSideEffect(sideEffect);
  let decisionContext = 'readonly tool; approval is not required';

  if (denied) {
    decisionContext = `blocked by configured deniedTools (${deniedPattern})`;
  } else if (!allowedBySafety) {
    decisionContext = `blocked by ${mode} safety mode`;
  } else if (requiresApproval && trusted) {
    decisionContext = `trusted by configured trustedTools (${trustedPattern})`;
  } else if (requiresApproval && boardAutoApproved) {
    decisionContext = 'auto-approved by board mode (/connect) after safety checks';
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
    boardAutoApproved,
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
  const sessionTrustedWorkspaces = new Set<string>();
  const workspaceRoot = workspaceTrustRoot(options.workspaceDir);

  return async (request: ToolApprovalRequest) => {
    const { tool } = request;
    // Live mode: an in-session escalation (/yolo) can widen the allowlist by
    // overriding the base mode for this call.
    const liveMode = options.safetyModeOverride?.() ?? mode;
    // "Full power" = no per-call prompt for mode-allowed tools. Sources: an
    // explicit --full-access / /yolo, approvalPolicy never, or DMOSS_*_AUTO_APPROVE.
    // full-access mode itself implies it (choosing full access means full power).
    const fullPower = options.autoApprove?.() === true
      || liveMode === 'full-access'
      || hasAutoApproval(env, options);
    const preview = describeCliToolApproval(request, liveMode, env, {
      ...options,
      trustedTools: [...(options.trustedTools ?? []), ...sessionTrustedTools],
    });
    const trustedWorkspace = isWorkspaceTrustEligible(preview.sideEffect) && sessionTrustedWorkspaces.has(workspaceRoot);
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
    if (!isAllowedInMode(liveMode, preview.sideEffect, options.boardMode?.() === true)) {
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" is blocked by ${liveMode} safety mode (side effect: ${preview.sideEffect}). ` +
          'Run /yolo (or relaunch with --full-access) to allow it for this session.',
      };
    }
    if (!preview.requiresApproval) return { approved: true };

    if (preview.trusted) {
      return { approved: true };
    }

    if (trustedWorkspace) {
      return { approved: true };
    }

    if (preview.boardAutoApproved) {
      return { approved: true };
    }

    if (preview.autoApproved) {
      return { approved: true };
    }

    // Full power (--full-access / /yolo / approvalPolicy never): the tool already
    // passed isAllowedInMode above, so this runs mode-allowed tools without a
    // per-call prompt. read-only still blocks all mutation, isCommandDangerous
    // still blocks dangerous commands inside the tool, and deniedTools still wins.
    if (fullPower) {
      return { approved: true };
    }

    if (interaction === 'acceptEdits') {
      return { approved: true };
    }

    // Non-interactive (headless / piped / `-p`): there is no TTY to prompt on, so
    // auto-approve what the mode already allows rather than dead-ending (`moss -p`
    // was unusable for any mutating tool). read-only still blocks all mutation at
    // isAllowedInMode above; the dangerous-command floor and deniedTools still apply.
    if (!process.stdin.isTTY) {
      return { approved: true };
    }

    const prompt = renderCliApprovalPrompt(preview, request.input, {
      workspaceDir: options.workspaceDir,
      device: options.device,
    });
    const answer = (await (interactiveAsker ?? defaultAskUser)(prompt)).trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
      if (isWorkspaceTrustEligible(preview.sideEffect)) {
        sessionTrustedWorkspaces.add(workspaceRoot);
      } else {
        sessionTrustedTools.add(tool.name);
      }
      return { approved: true };
    }
    if (answer === 'y' || answer === 'yes') {
      return { approved: true };
    }
    return { approved: false, reason: `User denied ${tool.name}.` };
  };
}
