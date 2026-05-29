import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { createCliRunRenderer, resolveCliDetailMode } from './output.js';

export function dmossVerboseTools(): boolean {
  return resolveCliDetailMode() === 'verbose';
}

export async function runOneShot(agent: DmossAgent, message: string, learner?: SkillLearner) {
  const renderer = createCliRunRenderer();
  for await (const event of agent.streamChat('cli', message)) {
    renderer.handle(event);
    if (event.type === 'done') {
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
    }
  }
}
