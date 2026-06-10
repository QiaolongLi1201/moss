/**
 * Slash-command registry — the single source of dispatch for commands shared
 * by the REPL and the TUI. Design and migration plan:
 * `docs/slash-command-architecture.md`.
 *
 * Phase 1 (current): pilot commands only (`/version`, `/connect`,
 * `/disconnect`) plus the shared unknown-command UX. Both surfaces dispatch
 * here FIRST and fall through to their legacy chains for unmigrated
 * commands; each later phase moves more commands in and shrinks the chains.
 *
 * Rules:
 * - The registry owns dispatch and surface-neutral behavior only. Business
 *   logic stays in its module (device-connect.ts, model-catalog.ts, …).
 * - Commands entangled with surface state (pickers, queue, attachments)
 *   stay surface-local — do not force them through CommandContext.
 */

import { estimateTokensForText } from '../../context/tokens.js';
import type { DmossAgent } from '../../core/index.js';
import { formatUsageSummary, readUsageLog, summarizeUsage } from '../../observability/index.js';
import {
  connectDeviceForSession,
  disconnectDeviceForSession,
  parseDeviceConnectArgs,
} from '../device-connect.js';
import { formatModelChoices, loadModelChoicesForRuntime } from '../model-catalog.js';
import {
  renderCliExamples,
  renderCliPermissions,
  renderCliQuickStart,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  type CliRuntimeStatus,
} from '../onboarding.js';
import { getPackageVersion } from '../package-info.js';

export type CommandSurface = 'repl' | 'tui';

export interface CommandContext {
  agent: DmossAgent;
  runtime: CliRuntimeStatus | undefined;
  sessionKey: string;
  workspace: string;
  locale?: string;
  surface: CommandSurface;
  /** Print to the surface (TUI transcript / REPL stderr). */
  say(kind: 'system' | 'error', text: string): void;
  /** Pre-fill the input line for a follow-up command. May be a no-op. */
  prefillInput(text: string): void;
  /**
   * Submit `text` as the next user turn (runs the model). Provided by surfaces
   * that can start a run; used by file-based custom commands to expand a
   * template into a prompt. Absent in headless/test contexts.
   */
  submitPrompt?(text: string): void;
}

export interface CommandSpec {
  /** Leading-slash command name, e.g. "/connect". */
  name: `/${string}`;
  /** Alternate names matched exactly, e.g. "/config" for "/permissions". */
  aliases?: readonly `/${string}`[];
  /** One-line summary; interactive help rows derive from this in phase 2. */
  summary: string;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}

function isZh(locale: string | undefined): boolean {
  return /^zh/i.test(locale ?? '');
}

const versionCommand: CommandSpec = {
  name: '/version',
  summary: 'show the moss CLI version',
  run(ctx) {
    ctx.say('system', `moss v${getPackageVersion()}`);
  },
};

const connectCommand: CommandSpec = {
  name: '/connect',
  summary: 'connect an RDK board and enter board mode',
  async run(ctx, args) {
    const parsed = parseDeviceConnectArgs(args);
    if (parsed.error) {
      ctx.say('error', parsed.error);
      return;
    }
    const config = parsed.config!;
    ctx.say('system', `[device] Verifying SSH to ${config.user}@${config.host}:${config.port} ...`);
    const result = await connectDeviceForSession(ctx.agent, ctx.runtime, config, {
      skipVerify: parsed.verify === false,
      mode: parsed.mode,
      locale: ctx.locale,
    });
    ctx.say(result.ok ? 'system' : 'error', result.message);
    if (!result.ok && result.retryInput) {
      // Recoverable failure (e.g. auth): pre-fill the retry command so the
      // user only types the missing part.
      ctx.prefillInput(result.retryInput);
    }
  },
};

const disconnectCommand: CommandSpec = {
  name: '/disconnect',
  summary: 'leave board mode and restore local tools',
  run(ctx) {
    ctx.say('system', disconnectDeviceForSession(ctx.agent, ctx.runtime));
  },
};

const quickstartCommand: CommandSpec = {
  name: '/quickstart',
  aliases: ['/quick_start', '/start'],
  summary: 'show setup and next-steps guidance',
  run(ctx) {
    ctx.say('system', renderCliQuickStart(ctx.agent, ctx.runtime));
  },
};

const statusCommand: CommandSpec = {
  name: '/status',
  summary: 'view model, workspace, device, and tool state',
  run(ctx, args) {
    ctx.say('system', renderCliStatus(ctx.agent, ctx.runtime, { verbose: args.includes('--verbose') }));
  },
};

const toolsCommand: CommandSpec = {
  name: '/tools',
  summary: 'list available tools and their capabilities',
  run(ctx) {
    ctx.say('system', renderCliTools(ctx.agent));
  },
};

const permissionsCommand: CommandSpec = {
  name: '/permissions',
  aliases: ['/config'],
  summary: 'show safety mode, approval policy, and permissions',
  run(ctx) {
    ctx.say('system', renderCliPermissions(ctx.runtime));
  },
};

const examplesCommand: CommandSpec = {
  name: '/examples',
  summary: 'show task examples for the active tools',
  run(ctx) {
    ctx.say('system', renderCliExamples(ctx.agent, ctx.runtime));
  },
};

const upgradeCommand: CommandSpec = {
  name: '/upgrade',
  summary: 'show how to upgrade the moss CLI',
  run(ctx) {
    ctx.say('system', renderCliUpgradeHelp());
  },
};

const modelsCommand: CommandSpec = {
  name: '/models',
  summary: 'list available language models',
  async run(ctx) {
    const modelChoices = await loadModelChoicesForRuntime(ctx.runtime?.config, ctx.agent.config.model ?? '', {
      fallbackProvider: (ctx.agent.config as { provider?: string }).provider,
    });
    ctx.say('system', formatModelChoices(modelChoices));
  },
};

const costCommand: CommandSpec = {
  name: '/cost',
  summary: 'show LLM usage recorded in this workspace',
  async run(ctx) {
    try {
      const records = await readUsageLog();
      if (records.length === 0) {
        ctx.say('system', [
          'Session usage',
          '  No LLM usage recorded yet in this workspace (.moss/llm-usage.jsonl).',
          '  Token counts and cost are logged once the agent makes an LLM call.',
        ].join('\n'));
      } else {
        ctx.say('system', formatUsageSummary(summarizeUsage(records)));
      }
    } catch (err) {
      ctx.say('error', `Could not read usage log: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

const contextCommand: CommandSpec = {
  name: '/context',
  summary: 'show message count and token usage in this session',
  async run(ctx) {
    try {
      const msgs = await ctx.agent.config.sessionStore.loadMessages(ctx.sessionKey);
      const tokens = msgs.reduce((n, m) => {
        const content = (m as { content?: unknown }).content;
        const text = typeof content === 'string' ? content : content ? JSON.stringify(content) : '';
        return n + estimateTokensForText(text);
      }, 0);
      const windowTokens = ctx.agent.config.contextTokens ?? 200_000;
      const pct = Math.min(100, Math.round((tokens / windowTokens) * 100));
      ctx.say('system', [
        'Context window',
        `  messages   ${msgs.length}`,
        `  usage      ~${tokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens (${pct}%)`,
        `  model      ${ctx.agent.config.model ?? ''}`,
      ].join('\n'));
    } catch (err) {
      ctx.say('error', `Could not read context: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

const COMMANDS: readonly CommandSpec[] = [
  versionCommand,
  connectCommand,
  disconnectCommand,
  quickstartCommand,
  statusCommand,
  toolsCommand,
  permissionsCommand,
  examplesCommand,
  upgradeCommand,
  modelsCommand,
  costCommand,
  contextCommand,
];

export interface RegistryMatch {
  spec: CommandSpec;
  args: string;
}

/** Built-in command names + aliases (with leading slash), for collision guards. */
export function registryCommandNames(): string[] {
  const names: string[] = [];
  for (const command of COMMANDS) {
    names.push(command.name, ...(command.aliases ?? []));
  }
  return names;
}

/**
 * Match `input` against registered commands ("/name" or "/name args...").
 * Built-ins are matched first; `customCommands` (file-based) only resolve a
 * name no built-in owns, so a custom file can never shadow a shipped command.
 */
export function findRegistryCommand(
  input: string,
  customCommands: readonly CommandSpec[] = [],
): RegistryMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const head = trimmed.split(/\s+/, 1)[0];
  const spec =
    COMMANDS.find(
      (command) => command.name === head || command.aliases?.includes(head as `/${string}`),
    ) ?? customCommands.find((command) => command.name === head);
  if (!spec) return null;
  return { spec, args: trimmed.slice(head.length).trim() };
}

/**
 * Dispatch `input` through the registry. Returns true when a registered
 * command handled it; false means the caller's legacy chain should run.
 */
export async function runRegistryCommand(
  input: string,
  ctx: CommandContext,
  customCommands: readonly CommandSpec[] = [],
): Promise<boolean> {
  const match = findRegistryCommand(input, customCommands);
  if (!match) return false;
  await match.spec.run(ctx, match.args);
  return true;
}

/**
 * Shared unknown-command message ("/" input never reaches the model — say so
 * instead of leaving the conversation silently deaf). The middle line is the
 * surface's own hint (nearest-command suggestion or an available-command
 * list).
 */
export function unknownSlashCommandLines(
  input: string,
  options: { suggestion?: string | null; locale?: string } = {},
): string[] {
  const zh = isZh(options.locale);
  return [
    zh ? `未知命令：${input}` : `Unknown command: ${input}`,
    options.suggestion
      ? (zh ? `是想输入 ${options.suggestion} 吗？` : `Did you mean ${options.suggestion}?`)
      : (zh ? '用 /help 查看全部命令。' : 'Use /help for available commands.'),
    zh
      ? '提示：以 / 开头的输入是 CLI 命令，不会发给模型。想让模型处理这句话，去掉行首的 / 重新发送。'
      : 'Note: "/" input is a CLI command and never reaches the model. To let the model handle it, resend without the leading "/".',
  ];
}
