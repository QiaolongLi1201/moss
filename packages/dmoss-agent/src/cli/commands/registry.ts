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
  renderCliMcp,
  renderCliPermissions,
  renderCliQuickStart,
  renderCliSessionDoctor,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  type CliRuntimeStatus,
} from '../onboarding.js';
import { runProcess } from '../../utils/run-process.js';
import { DmossError, ErrorCode } from '../../errors.js';
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

const mcpCommand: CommandSpec = {
  name: '/mcp',
  summary: 'show configured MCP servers, connection status, and tool counts',
  run(ctx) {
    ctx.say('system', renderCliMcp(ctx.runtime));
  },
};

const doctorCommand: CommandSpec = {
  name: '/doctor',
  summary: 'health-check model, egress, board, MCP, and config in this session',
  run(ctx) {
    ctx.say('system', renderCliSessionDoctor(ctx.agent, ctx.runtime));
  },
};

const yoloCommand: CommandSpec = {
  name: '/yolo',
  summary: 'grant FULL POWER for this session — run any tool without per-call approval (/yolo off to revert)',
  run(ctx, args) {
    const off = /^(off|0|false|stop|no)$/i.test(args.trim());
    if (!ctx.runtime) {
      ctx.say('error', '/yolo is unavailable in this context.');
      return;
    }
    if (off) {
      ctx.runtime.fullPower = false;
      ctx.say('system', 'Full power OFF — back to your base safety mode (mutating tools ask for approval again).');
      return;
    }
    ctx.runtime.fullPower = true;
    ctx.say('system', [
      '⚡ FULL POWER ON for this session — every tool the model picks runs WITHOUT a per-call prompt,',
      'including file writes, shell commands, and (after /connect) board actuation.',
      'Still enforced: dangerous commands (rm -rf /, mkfs, curl|sh, …) stay blocked, and configured',
      'deniedTools are never run. Type /yolo off to revert to approval prompts.',
    ].join('\n'));
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

/**
 * Code-review instruction modeled on Claude Code's /review (pr-review-toolkit):
 * four dimensions — correctness/bugs, security, simplification, type design —
 * with high-signal filtering and file:line citations. The diff is gathered by
 * the CLI (so the model reviews a concrete change, not the whole repo) and the
 * model runs the review as a normal turn with its own tools.
 */
function buildReviewPrompt(diff: string, scopeLabel: string): string {
  return [
    `You are reviewing the following code change (${scopeLabel}). Review ONLY the diff below;`,
    'do not review pre-existing code unrelated to these changes. Read surrounding files with your',
    'tools only when a hunk is ambiguous.',
    '',
    'Review across these dimensions and report HIGH-SIGNAL findings only (skip style nitpicks a',
    'linter would catch and anything you cannot confirm from the diff):',
    '  1. Correctness & bugs — logic errors, null/undefined handling, race conditions, off-by-one,',
    '     wrong results regardless of input, broken control flow.',
    '  2. Security — injection, unsafe child-process/shell, secret/credential leaks, missing input',
    '     validation, path traversal, unsafe deserialization.',
    '  3. Simplification — duplicated logic, dead code, needless abstraction or nesting that can be',
    '     removed without changing behavior.',
    '  4. Type design — weak invariants, types that allow invalid states, `any`/unsafe casts that',
    '     hide real type debt.',
    '',
    'For each finding give: dimension, file:line, a one-line description, and a concrete fix. If a',
    'project guideline file (CLAUDE.md / AGENTS.md) covers a changed file, flag clear violations and',
    'quote the rule. Group findings by severity (Critical / Important / Suggestion). If nothing is',
    'wrong, say so explicitly — do not invent issues.',
    '',
    '--- BEGIN DIFF ---',
    diff,
    '--- END DIFF ---',
  ].join('\n');
}

const reviewCommand: CommandSpec = {
  name: '/review',
  summary: 'review the working-tree diff (or `/review <PR#>`) for bugs, security, and simplification',
  async run(ctx, args) {
    if (!ctx.submitPrompt) {
      ctx.say('error', '/review needs a session that can start a run; it is unavailable in this context.');
      return;
    }
    const arg = args.trim();
    try {
      let diff: string;
      let scopeLabel: string;
      if (arg) {
        const prNumber = arg.replace(/^#/, '');
        if (!/^\d+$/.test(prNumber)) {
          ctx.say('error', 'Usage: /review            (working tree + staged changes)\n       /review <PR#>     (a GitHub pull request via `gh pr diff`)');
          return;
        }
        const result = await runProcess('gh', { args: ['pr', 'diff', prNumber], cwd: ctx.workspace, timeout: 30_000 });
        if (result.exitCode !== 0) {
          throw new DmossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: `gh pr diff ${prNumber} failed (exit ${result.exitCode})`,
            hint: 'Install and authenticate the GitHub CLI (`gh auth login`) and run inside the repo, or use `/review` with no argument to review local changes.',
            cause: result.stderr.trim() || undefined,
          });
        }
        diff = result.stdout;
        scopeLabel = `GitHub PR #${prNumber}`;
      } else {
        const result = await runProcess('git', { args: ['--no-pager', 'diff', 'HEAD'], cwd: ctx.workspace, timeout: 30_000 });
        if (result.exitCode !== 0) {
          const notRepo = /not a git repository/i.test(result.stderr);
          throw new DmossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: notRepo
              ? `Not a git repository: ${ctx.workspace} — /review needs a git workspace.`
              : `git diff failed (exit ${result.exitCode})`,
            hint: notRepo ? 'Open a git repository, or pass a PR number: `/review <PR#>`.' : result.stderr.trim() || undefined,
          });
        }
        diff = result.stdout;
        scopeLabel = 'local working tree + staged changes';
      }

      if (!diff.trim()) {
        ctx.say('system', arg
          ? `No changes found in PR ${arg}.`
          : 'No changes to review (working tree and index are clean). Make some edits, or pass a PR number: /review <PR#>.');
        return;
      }

      // Soft cap: a huge or binary-heavy diff would overflow the model context.
      // Truncate with a clear marker rather than streaming megabytes verbatim.
      const MAX_DIFF_CHARS = 400_000;
      const totalLines = diff.split('\n').length;
      let reviewDiff = diff;
      let truncatedNote = '';
      if (diff.length > MAX_DIFF_CHARS) {
        const kept = diff.slice(0, MAX_DIFF_CHARS);
        const keptLines = kept.split('\n').length;
        reviewDiff = `${kept}\n\n[diff truncated: showing ${keptLines} of ${totalLines} lines (${Math.round(MAX_DIFF_CHARS / 1024)} KB cap). Narrow the scope — review specific paths or stage a subset — for a complete review.]`;
        truncatedNote = ` — truncated to ${Math.round(MAX_DIFF_CHARS / 1024)} KB; narrow the scope for full coverage`;
      }

      ctx.say('system', `Reviewing ${scopeLabel} (${totalLines} diff lines)${truncatedNote} …`);
      ctx.submitPrompt(buildReviewPrompt(reviewDiff, scopeLabel));
    } catch (err) {
      const dmoss = err instanceof DmossError ? err : new DmossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `Could not gather a diff for review: ${err instanceof Error ? err.message : String(err)}`,
      });
      ctx.say('error', dmoss.hint ? `${dmoss.message}\n  ${dmoss.hint}` : dmoss.message);
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
  mcpCommand,
  doctorCommand,
  reviewCommand,
  yoloCommand,
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
