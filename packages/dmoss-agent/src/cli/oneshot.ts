import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { createCliRunRenderer, resolveCliDetailMode } from './output.js';

export function dmossVerboseTools(): boolean {
  return resolveCliDetailMode() === 'verbose';
}

export interface RunOneShotOptions {
  sessionKey?: string;
  /** 输出格式：text=人类渲染(默认) / json=最终结果对象 / stream-json=逐事件 NDJSON。后两者供 RDK Studio 产品层/CI 编程驱动。 */
  outputFormat?: 'text' | 'json' | 'stream-json';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ type: 'error', message: 'unserializable event' });
  }
}

export async function runOneShot(
  agent: DmossAgent,
  message: string,
  learner?: SkillLearner,
  options: RunOneShotOptions = {},
) {
  const sessionKey = options.sessionKey || 'cli';
  const outputFormat = options.outputFormat || 'text';
  const renderer = outputFormat === 'text' ? createCliRunRenderer() : null;
  let finalText = '';
  for await (const event of agent.streamChat(sessionKey, message)) {
    if (outputFormat === 'stream-json') {
      process.stdout.write(`${safeJson(event)}\n`);
    } else if (outputFormat === 'json') {
      if (event.type === 'text_delta') finalText += event.delta;
    } else {
      renderer?.handle(event);
    }
    if (event.type === 'done') {
      if (outputFormat === 'json') {
        process.stdout.write(`${safeJson({ type: 'result', sessionKey, text: finalText, result: event.result ?? null })}\n`);
      }
      if (learner && event.result?.toolCalls && event.result.toolCalls.length >= 2) {
        try {
          const messages = await agent.config.sessionStore.loadMessages(sessionKey);
          const skillPath = await learner.maybeLearnFromSession(sessionKey, messages);
          if (skillPath && dmossVerboseTools() && outputFormat === 'text') {
            process.stderr.write(`\n[learned] Skill saved: ${path.basename(skillPath)}\n`);
          }
        } catch {
          /* non-critical */
        }
      }
    }
  }
}
