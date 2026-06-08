import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { estimateTokensForText } from '../context/tokens.js';
import { handleGoalCommand } from '../goal.js';
import { readUsageLog, summarizeUsage, formatUsageSummary } from '../observability/index.js';
import { setCliApprovalAsker } from './approval.js';
import { handleCompactCommand } from './compact-command.js';
import { formatCommunityAuthStatus, renderCommunityAuthRequiredMessage } from './community-auth.js';
import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';
import { formatModelChoices, loadModelChoicesForRuntime, resolveModelSelection } from './model-catalog.js';
import { runOneShot } from './oneshot.js';
import {
  renderCliDetailHelp,
  renderCliExamples,
  renderCliInteractiveHelp,
  renderCliPermissions,
  renderCliQuickStart,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  renderCliWelcome,
  type CliRuntimeStatus,
} from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, label, ui } from './ui.js';
import { formatTuiSessions, renderSkills, runInkInteractive, runLocalShellCommand } from './tui.js';

let currentModel = '';

export const INTERACTIVE_COMMANDS = [...INTERACTIVE_COMPLETION_COMMANDS];

function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

export function completeInteractiveCommand(line: string): [string[], string] {
  const hits = INTERACTIVE_COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
}

async function handleInteractiveAuthCommand(
  msg: string,
  runtime: CliRuntimeStatus | undefined,
  write: (message: string) => void,
): Promise<boolean> {
  const auth = runtime?.communityAuth;
  if (!(msg === '/auth' || msg.startsWith('/auth ') || msg === '/logout')) return false;
  if (!auth) {
    write('[auth] Community auth runtime is unavailable in this session.');
    return true;
  }
  if (msg === '/auth' || msg === '/auth status') {
    write(`[auth] ${formatCommunityAuthStatus(auth.getStatus())}`);
    return true;
  }
  if (msg === '/auth login') {
    try {
      const context = await auth.login(write);
      write(`[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`);
    } catch (err) {
      write(`[auth] Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
  if (msg === '/logout' || msg === '/auth logout') {
    const removed = auth.logout();
    write(removed
      ? '[auth] Logged out of the D-Robotics developer community.'
      : '[auth] No D-Robotics developer community session is stored.');
    return true;
  }
  write('Usage: /auth <login|status|logout>');
  return true;
}

export async function runInteractive(
  agent: DmossAgent,
  skillLearner?: SkillLearner,
  runtime?: CliRuntimeStatus,
  options: { sessionKey?: string } = {},
) {
  if (process.stdin.isTTY && process.stdout.isTTY && process.env.DMOSS_CLI_TUI !== '0') {
    await runInkInteractive(agent, skillLearner, runtime, options);
    return;
  }

  currentModel = agent.config.model || currentModel;
  const workspace = runtime?.workspace || process.cwd();
  const sessionKey = options.sessionKey || createCliSessionKey();
  let closed = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n› ',
    completer: completeInteractiveCommand,
  });
  setCliApprovalAsker((question) => new Promise((resolve) => {
    const onSigint = () => {
      rl.off('SIGINT', onSigint);
      resolve('');
    };
    rl.once('SIGINT', onSigint);
    rl.question(question, (answer) => {
      rl.off('SIGINT', onSigint);
      resolve(answer);
    });
  }));

  console.error(renderCliWelcome(agent, { ...runtime, sessionKey }));
  console.error(ui.dim(`${label('directory')} ${compactPath(workspace)}   ${label('exit')} Ctrl+D or /quit`));
  rl.prompt();
  if (runtime?.configDir) {
    startCliUpdateCheck({
      configDir: runtime.configDir,
      currentVersion: getPackageVersion(),
      onNotice: (message) => {
        if (closed) return;
        console.error(`\n${message}`);
        rl.prompt(true);
      },
    });
  }

  for await (const line of rl) {
    const msg = line.trim();
    if (!msg) {
      rl.prompt();
      continue;
    }
    if (msg === '/quit' || msg === '/exit') break;

    if (await handleInteractiveAuthCommand(msg, runtime, (message) => console.error(message))) {
      rl.prompt();
      continue;
    }

    if (msg === '/help') {
      console.error(renderCliInteractiveHelp());
      rl.prompt();
      continue;
    }

    if (msg === '/quick_start' || msg === '/start') {
      console.error(renderCliQuickStart(agent, runtime));
      rl.prompt();
      continue;
    }

    if (msg === '/status') {
      console.error(renderCliStatus(agent, runtime));
      rl.prompt();
      continue;
    }

    if (msg === '/goal' || msg.startsWith('/goal ')) {
      const result = await handleGoalCommand({ agent, sessionKey, input: msg, locale: cliLocale() });
      console.error(result.message);
      rl.prompt();
      continue;
    }

    if (msg === '/compact') {
      try {
        console.error(await handleCompactCommand(agent, sessionKey));
      } catch (err) {
        console.error(`[compact] ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/permissions' || msg === '/config') {
      console.error(renderCliPermissions(runtime));
      rl.prompt();
      continue;
    }

    if (msg === '/tools') {
      console.error(renderCliTools(agent));
      rl.prompt();
      continue;
    }

    if (msg === '/examples') {
      console.error(renderCliExamples(agent, runtime));
      rl.prompt();
      continue;
    }

    if (msg === '/upgrade') {
      console.error(renderCliUpgradeHelp());
      rl.prompt();
      continue;
    }

    if (msg === '/sessions' || msg === '/session') {
      try {
        const sessions = await agent.config.sessionStore.listSessions();
        console.error(formatTuiSessions(sessions, sessionKey));
      } catch (err) {
        console.error(`[sessions] ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/context') {
      try {
        const msgs = await agent.config.sessionStore.loadMessages(sessionKey);
        const tokens = msgs.reduce((n, m) => {
          const content = (m as { content?: unknown }).content;
          const text = typeof content === 'string' ? content : content ? JSON.stringify(content) : '';
          return n + estimateTokensForText(text);
        }, 0);
        const windowTokens = agent.config.contextTokens ?? 200_000;
        const pct = Math.min(100, Math.round((tokens / windowTokens) * 100));
        console.error([
          'Context window',
          `  messages   ${msgs.length}`,
          `  usage      ~${tokens.toLocaleString()} / ${windowTokens.toLocaleString()} tokens (${pct}%)`,
          `  model      ${currentModel}`,
        ].join('\n'));
      } catch (err) {
        console.error(`[context] ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/cost') {
      try {
        const records = await readUsageLog();
        console.error(records.length === 0
          ? 'Session usage\n  No LLM usage recorded yet in this workspace (.dmoss/llm-usage.jsonl).'
          : formatUsageSummary(summarizeUsage(records)));
      } catch (err) {
        console.error(`[cost] ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/diff' || msg.startsWith('/diff ')) {
      try {
        const result = await runLocalShellCommand({
          command: 'git --no-pager diff --stat && git --no-pager diff',
          cwd: workspace,
        });
        console.error(result.output.trim() || '(no unstaged working-tree changes)');
      } catch (err) {
        console.error(`[diff] ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
      continue;
    }

    if (
      msg === '/rewind'
      || msg.startsWith('/rewind ')
      || msg === '/queue'
      || msg.startsWith('/queue ')
      || msg === '/stop'
      || msg === '/abort'
      || msg === '/thinking'
      || msg === '/clear'
      || msg === '/init'
    ) {
      console.error('[help] This control is available in the full terminal TUI. Open dmoss in a TTY to use it.');
      rl.prompt();
      continue;
    }

    if (msg === '/model' || msg.startsWith('/model ')) {
      const newModel = msg === '/model' ? '' : msg.slice(7).trim();
      const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
        fallbackProvider: (agent.config as { provider?: string }).provider,
      });
      if (newModel) {
        const selected = resolveModelSelection(newModel, modelChoices.choices);
        const model = selected?.model ?? newModel;
        currentModel = model;
        agent.config.model = model;
        if (runtime?.config) {
          runtime.config.model = model;
          runtime.config.modelSource = 'cli';
        }
        console.error(selected
          ? `[config] Model switched to: ${model} (${modelChoices.provider})`
          : `[config] Model switched to custom model: ${model} (${modelChoices.provider})`);
      } else {
        console.error(formatModelChoices(modelChoices));
      }
      rl.prompt();
      continue;
    }

    if (msg === '/models') {
      const modelChoices = await loadModelChoicesForRuntime(runtime?.config, currentModel, {
        fallbackProvider: (agent.config as { provider?: string }).provider,
      });
      console.error(formatModelChoices(modelChoices));
      rl.prompt();
      continue;
    }

    if (msg === '/version') {
      console.error(`dmoss v${getPackageVersion()}`);
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/detail')) {
      const mode = msg.slice('/detail'.length).trim().toLowerCase();
      if (mode === 'quiet' || mode === 'progress' || mode === 'verbose') {
        process.env.DMOSS_CLI_DETAIL = mode;
        console.error(`[config] CLI detail set to: ${mode}`);
      } else {
        console.error(renderCliDetailHelp());
      }
      rl.prompt();
      continue;
    }

    if (msg === '/memory') {
      const memDir = path.join(workspace, '.dmoss-runtime', 'memory');
      try {
        const indexPath = path.join(memDir, 'index.json');
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const entries = JSON.parse(raw);
        console.error(`[memory] ${entries.length} entries stored`);
        for (const e of entries.slice(0, 5)) {
          console.error(`  - [${e.id}] ${e.content.slice(0, 80)}...`);
        }
        if (entries.length > 5) console.error(`  ... and ${entries.length - 5} more`);
      } catch {
        console.error('[memory] No memories stored yet.');
      }
      rl.prompt();
      continue;
    }

    if (msg === '/skills') {
      console.error(renderSkills(workspace));
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/')) {
      console.error(`[help] Unknown command: ${msg}`);
      console.error(`[help] Available: ${INTERACTIVE_COMMANDS.filter((cmd) => !cmd.includes(' ')).join(' ')}`);
      rl.prompt();
      continue;
    }

    if (runtime?.communityAuth && !runtime.communityAuth.getStatus().authenticated) {
      console.error(renderCommunityAuthRequiredMessage({ interactive: true }));
      rl.prompt();
      continue;
    }

    await runOneShot(agent, msg, skillLearner, { sessionKey });
    rl.prompt();
  }

  closed = true;
  setCliApprovalAsker(null);
  rl.close();
}
