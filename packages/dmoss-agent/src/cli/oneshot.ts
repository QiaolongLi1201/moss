import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';

export function dmossVerboseTools(): boolean {
  return process.env.DMOSS_VERBOSE_TOOLS === 'true' || process.env.DMOSS_VERBOSE_CLI === 'true';
}

export async function runOneShot(agent: DmossAgent, message: string, learner?: SkillLearner) {
  for await (const event of agent.streamChat('cli', message)) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.delta);
        break;
      case 'tool_start':
        if (dmossVerboseTools()) process.stderr.write(`\n[tool] ${event.toolName}...\n`);
        break;
      case 'tool_end':
        if (dmossVerboseTools() && event.isError)
          process.stderr.write(`[tool] ${event.toolName} failed\n`);
        break;
      case 'done':
        process.stdout.write('\n');
        if (learner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
          try {
            const messages = await agent.config.sessionStore.loadMessages('cli');
            const skillPath = await learner.maybeLearnFromSession('cli', messages);
            if (skillPath && dmossVerboseTools()) {
              process.stderr.write(`\n[learned] Skill saved: ${path.basename(skillPath)}\n`);
            }
          } catch {
            /* non-critical */
          }
        }
        break;
    }
  }
}
