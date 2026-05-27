import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { MODEL, WORKSPACE } from './config.js';
import { runOneShot } from './oneshot.js';

let currentModel = MODEL;

export async function runInteractive(agent: DmossAgent, skillLearner?: SkillLearner) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: '\n> ',
  });

  console.error(`D-Moss Agent (model: ${currentModel}, workspace: ${WORKSPACE})`);
  console.error('Commands: /model <name> | /models | /memory | /skills | /quit');
  console.error('Type your message and press Enter. Ctrl+C to exit.\n');
  rl.prompt();

  for await (const line of rl) {
    const msg = line.trim();
    if (!msg) {
      rl.prompt();
      continue;
    }
    if (msg === '/quit' || msg === '/exit') break;

    if (msg.startsWith('/model ')) {
      const newModel = msg.slice(7).trim();
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
      console.error('[help] Available: /model /models /memory /skills /quit');
      rl.prompt();
      continue;
    }

    await runOneShot(agent, msg, skillLearner);
    rl.prompt();
  }

  rl.close();
}
