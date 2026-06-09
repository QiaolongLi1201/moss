import path from 'node:path';
import type { DmossAgent } from '../core/index.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { createCliRunRenderer, resolveCliDetailMode } from './output.js';
import {
  createHeadlessPrintState,
  formatHeadlessInitEvent,
  formatHeadlessStreamEvent,
  formatHeadlessThrownError,
  isHeadlessResultError,
  type HeadlessOutputFormat,
  type HeadlessResultEvent,
  type HeadlessStreamEvent,
  writeHeadlessJson,
  type HeadlessJsonWriter,
} from './print.js';
import { createCliSessionKey } from './session.js';

export function dmossVerboseTools(): boolean {
  return resolveCliDetailMode() === 'verbose';
}

export interface RunOneShotOptions {
  sessionKey?: string;
  outputFormat?: HeadlessOutputFormat;
  headless?: boolean;
  cwd?: string;
  stdout?: HeadlessJsonWriter;
}

const BRIEF_ONE_SHOT_MAX_TURNS = 6;
const BRIEF_ONE_SHOT_MAX_TOOL_CALLS = 4;
const BRIEF_ONE_SHOT_CONTEXT = [
  'One-shot brief-answer mode:',
  '- The user explicitly requested a short answer. Prefer answering directly.',
  '- Do not use create_subagent or fan_out_subagents.',
  '- Use at most one or two targeted file/search reads, then answer with any uncertainty stated plainly.',
  '- Do not broaden into a full codebase review unless the user asks for it.',
].join('\n');

export function isBriefOneShotRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /(?:简短|短答|[0-9０-９一二三四五六七八九十]+\s*行以内|控制在\s*[0-9０-９一二三四五六七八九十]+\s*行|within\s+\d+\s+lines?)/iu.test(text);
}

export async function runOneShot(
  agent: DmossAgent,
  message: string,
  learner?: SkillLearner,
  options: RunOneShotOptions = {},
) {
  const sessionKey = options.sessionKey || createCliSessionKey();
  const outputFormat = options.outputFormat || 'text';
  const stdout = options.stdout ?? process.stdout;
  const renderer = outputFormat === 'text' ? createCliRunRenderer() : null;
  const state = createHeadlessPrintState({
    sessionId: sessionKey,
    model: agent.config.model,
    startTime: Date.now(),
  });
  let finalResult: HeadlessResultEvent | undefined;

  function rememberStructuredResult(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') finalResult = structured;
    }
  }

  function writeStructured(events: HeadlessStreamEvent[]): void {
    for (const structured of events) {
      if (structured.type === 'result') finalResult = structured;
      if (outputFormat === 'stream-json' || structured.type === 'result') {
        writeHeadlessJson(stdout, structured);
      }
    }
  }

  if (outputFormat === 'stream-json') {
    writeHeadlessJson(stdout, formatHeadlessInitEvent({
      cwd: options.cwd ?? process.cwd(),
      model: agent.config.model,
      tools: agent.tools.getAll().map((tool) => tool.name),
      sessionId: sessionKey,
    }));
  }

  try {
    const brief = isBriefOneShotRequest(message);
    for await (const event of agent.streamChat(sessionKey, message, brief
      ? { maxTurns: BRIEF_ONE_SHOT_MAX_TURNS, maxToolCalls: BRIEF_ONE_SHOT_MAX_TOOL_CALLS, extraContext: BRIEF_ONE_SHOT_CONTEXT }
      : undefined)) {
      const structuredEvents = formatHeadlessStreamEvent(state, event);
      if (outputFormat === 'text') {
        renderer?.handle(event);
        rememberStructuredResult(structuredEvents);
      } else {
        writeStructured(structuredEvents);
      }
      if (event.type === 'done') {
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
  } catch (err) {
    if (outputFormat === 'text') throw err;
    writeStructured(formatHeadlessThrownError(state, err));
  }

  if (finalResult && (options.headless || outputFormat !== 'text') && isHeadlessResultError(finalResult)) {
    process.exitCode = 1;
  }
}
