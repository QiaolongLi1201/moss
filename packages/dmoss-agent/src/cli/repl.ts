import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { setCliApprovalAsker } from './approval.js';
import { MODEL, WORKSPACE } from './config.js';
import { runOneShot } from './oneshot.js';
import {
  renderCliDetailHelp,
  renderCliExamples,
  renderCliInteractiveHelp,
  renderCliStatus,
  renderCliTools,
  renderCliUpgradeHelp,
  renderCliWelcome,
  type CliRuntimeStatus,
} from './onboarding.js';
import { getPackageVersion } from './package-info.js';
import { startCliUpdateCheck } from './update-check.js';

let currentModel = MODEL;

export const INTERACTIVE_COMMANDS = [
  '/help',
  '/tools',
  '/status',
  '/examples',
  '/model',
  '/models',
  '/detail',
  '/detail quiet',
  '/detail progress',
  '/detail verbose',
  '/memory',
  '/skills',
  '/upgrade',
  '/quit',
  '/exit',
];

export function completeInteractiveCommand(line: string): [string[], string] {
  const hits = INTERACTIVE_COMMANDS.filter((cmd) => cmd.startsWith(line));
  return [hits.length ? hits : INTERACTIVE_COMMANDS, line];
}

export async function runInteractive(
  agent: DmossAgent,
  skillLearner?: SkillLearner,
  runtime?: CliRuntimeStatus,
) {
  let closed = false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n> ',
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

  console.error(renderCliWelcome(agent, runtime));
  console.error('');
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

    if (msg === '/help') {
      console.error(renderCliInteractiveHelp());
      rl.prompt();
      continue;
    }

    if (msg === '/status') {
      console.error(renderCliStatus(agent, runtime));
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

    if (msg === '/model' || msg.startsWith('/model ')) {
      const newModel = msg === '/model' ? '' : msg.slice(7).trim();
      if (newModel) {
        currentModel = newModel;
        agent.config.model = newModel;
        console.error(`[config] Model switched to: ${newModel}`);
      } else {
        console.error(`[config] Current model: ${currentModel}`);
      }
      rl.prompt();
      continue;
    }

    if (msg === '/models') {
      console.error(`[config] Current model: ${currentModel}`);
      console.error('[config] Switch with: /model <model-name>');
      console.error('[config] Examples:');
      console.error('  /model gpt-4o');
      console.error('  /model claude-sonnet-4-20250514');
      console.error('  /model qwen-plus');
      console.error('  /model deepseek-chat');
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
      const memDir = path.join(WORKSPACE, '.dmoss-runtime', 'memory');
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
      const learnedDir = path.join(WORKSPACE, 'skills', 'learned');
      try {
        const files = fs.readdirSync(learnedDir).filter((f: string) => f.endsWith('.md'));
        console.error(`[skills] ${files.length} learned skills:`);
        for (const f of files) {
          console.error(`  - ${f}`);
        }
      } catch {
        console.error('[skills] No learned skills yet.');
      }
      rl.prompt();
      continue;
    }

    if (msg.startsWith('/')) {
      console.error(`[help] Unknown command: ${msg}`);
      console.error('[help] Available: /help /tools /status /examples /model /models /detail /memory /skills /upgrade /quit');
      rl.prompt();
      continue;
    }

    await runOneShot(agent, msg, skillLearner);
    rl.prompt();
  }

  closed = true;
  setCliApprovalAsker(null);
  rl.close();
}
