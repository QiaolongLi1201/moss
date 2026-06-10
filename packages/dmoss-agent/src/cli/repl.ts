import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { handleGoalCommand } from '../goal.js';
import { setCliApprovalAsker } from './approval.js';
import { handleCompactCommand } from './compact-command.js';
import { formatCommunityAuthLoginError, formatCommunityAuthStatus } from './community-auth.js';
import { runRegistryCommand, unknownSlashCommandLines } from './commands/registry.js';
import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';
import {
  formatCustomModelConfigInstructions,
  formatModelChoices,
  loadModelChoicesForRuntime,
  parseCustomModelConfigInput,
  resolveModelSelection,
} from './model-catalog.js';
import { loadConfigFile, resolveConfigPath, saveConfigFileAtPath } from './config.js';
import { createCliProvider } from './providers.js';
import { runOneShot } from './oneshot.js';
import {
  renderCliDetailHelp,
  renderCliInteractiveHelp,
  renderCliWelcome,
  type CliRuntimeStatus,
} from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { createCliSessionKey } from './session.js';
import { startCliUpdateCheck } from './update-check.js';
import { compactPath, label, ui } from './ui.js';
import { formatTuiSessions, renderSkills, runInkInteractive, runLocalShellCommand } from './tui.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';

let currentModel = '';

export const INTERACTIVE_COMMANDS = [...INTERACTIVE_COMPLETION_COMMANDS];

function applyCustomModelConfigForRepl(agent: DmossAgent, runtime: CliRuntimeStatus | undefined, rawConfig: string): string {
  const configPath = runtime?.config?.configPath ?? resolveConfigPath();
  const parsed = parseCustomModelConfigInput(rawConfig);
  if (!parsed.ok) return `${parsed.message}\n\n${formatCustomModelConfigInstructions(configPath)}`;
  const nextConfig = parsed.config;
  const currentConfig = loadConfigFile(configPath);
  saveConfigFileAtPath({
    ...currentConfig,
    provider: nextConfig.provider,
    model: nextConfig.model,
    baseUrl: nextConfig.baseUrl,
    apiKey: nextConfig.apiKey,
    ...(nextConfig.imageInput === undefined ? {} : { imageInput: nextConfig.imageInput }),
  }, configPath);

  if (runtime?.config) {
    runtime.config.provider = nextConfig.provider;
    runtime.config.providerSource = 'config';
    runtime.config.model = nextConfig.model;
    runtime.config.modelSource = 'config';
    runtime.config.baseUrl = nextConfig.baseUrl;
    runtime.config.baseUrlSource = 'config';
    runtime.config.apiKey = nextConfig.apiKey;
    runtime.config.apiKeySource = 'config';
    runtime.config.usingBundledDefault = false;
    if (nextConfig.imageInput !== undefined) {
      runtime.config.imageInput = nextConfig.imageInput;
      runtime.config.imageInputSource = 'config';
    }
  }

  currentModel = nextConfig.model;
  agent.config.model = nextConfig.model;
  (agent.config as { provider?: string; baseUrl?: string }).provider = nextConfig.provider;
  (agent.config as { provider?: string; baseUrl?: string }).baseUrl = nextConfig.baseUrl;
  agent.config.llmProvider = createCliProvider({
    provider: nextConfig.provider,
    apiKey: nextConfig.apiKey,
    model: nextConfig.model,
    baseUrl: nextConfig.baseUrl,
    imageInput: nextConfig.imageInput,
  });

  return [
    `[config] Custom model configured: ${nextConfig.model} (${nextConfig.provider})`,
    `[config] Saved to ${configPath}`,
  ].join('\n');
}

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
  if (msg === '/auth login' || msg.startsWith('/auth login ')) {
    const manual = msg.split(/\s+/).includes('--manual');
    try {
      const context = await auth.login(write, { manual });
      write(`[auth] Ready. Logged in as ${context.user.name || context.user.email || context.user.id}.`);
    } catch (err) {
      write(`[auth] ${formatCommunityAuthLoginError(err)}`);
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

function basicReplUnsupportedMessage(command: string): string {
  const token = command.split(/\s+/, 1)[0] || command;
  if (token === '/rewind') return '[help] /rewind needs the full TUI checkpoint view. Use `git diff` or `/diff` here to inspect changes.';
  if (token === '/queue') return '[help] Queue controls need the full TUI. This basic REPL runs one prompt at a time.';
  if (token === '/stop' || token === '/abort') return '[help] Press Ctrl+C to interrupt the terminal process in this basic REPL.';
  if (token === '/thinking') return '[help] Thinking display is a full TUI control. Use `/detail verbose` for more runtime detail here.';
  if (token === '/clear') return '[help] Use Ctrl+L or your shell `clear` command to clear this terminal.';
  if (token === '/init') return '[help] /init is available in the full TUI. In this REPL, create AGENTS.md in your workspace manually.';
  return '[help] This control is available in the full terminal TUI.';
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

    // Registry-first dispatch (docs/slash-command-architecture.md): shared
    // commands live in the registry; the legacy chain below shrinks with
    // each migration phase.
    if (msg.startsWith('/')) {
      let pendingPrefill: string | null = null;
      const handled = await runRegistryCommand(msg, {
        agent,
        runtime,
        sessionKey,
        workspace,
        locale: cliLocale(),
        surface: 'repl',
        say: (_kind, text) => console.error(text),
        prefillInput: (text) => {
          pendingPrefill = text;
        },
      });
      if (handled) {
        rl.prompt();
        if (pendingPrefill) rl.write(pendingPrefill);
        continue;
      }
    }

    if (await handleInteractiveAuthCommand(msg, runtime, (message) => console.error(message))) {
      rl.prompt();
      continue;
    }

    if (msg === '/help') {
      console.error(renderCliInteractiveHelp());
      rl.prompt();
      continue;
    }

    // /connect and /disconnect are handled by the command registry above.

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
        console.error('[compact] You can keep chatting; try /status --verbose to inspect context, or ask Moss to summarize the current session manually.');
      }
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
      console.error(basicReplUnsupportedMessage(msg));
      rl.prompt();
      continue;
    }

    if (msg === '/model' || msg.startsWith('/model ')) {
      const newModel = msg === '/model' ? '' : msg.slice(7).trim();
      if (newModel === 'config' || newModel.startsWith('config ')) {
        const rawConfig = newModel === 'config' ? '' : newModel.slice('config'.length).trim();
        try {
          console.error(applyCustomModelConfigForRepl(agent, runtime, rawConfig));
        } catch (err) {
          console.error(`[config] Could not save model config: ${err instanceof Error ? err.message : String(err)}`);
        }
        rl.prompt();
        continue;
      }
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

    // /version is handled by the command registry above.

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
      const paths = getMossWorkspacePaths(workspace);
      const memDir = fs.existsSync(paths.memoryDir) ? paths.memoryDir : paths.legacyMemoryDir;
      try {
        const indexPath = path.join(memDir, 'index.json');
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const entries = JSON.parse(raw);
        console.error(`[memory] ${entries.length} entries stored`);
        for (const e of entries.slice(0, 5)) {
          console.error(`  - [${e.id}] ${e.content.slice(0, 80)}...`);
        }
        if (entries.length > 5) console.error(`  ... and ${entries.length - 5} more`);
      } catch (err) {
        // Only a missing index means "no memories" — a malformed file or a
        // permission error is a real failure and must not be masked.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          console.error('[memory] No memories stored yet.');
        } else {
          console.error(`[memory] Failed to read memory index: ${err instanceof Error ? err.message : String(err)}`);
        }
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
      for (const line of unknownSlashCommandLines(msg, { locale: cliLocale() })) {
        console.error(`[help] ${line}`);
      }
      console.error(`[help] Available: ${INTERACTIVE_COMMANDS.filter((cmd) => !cmd.includes(' ')).join(' ')}`);
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
