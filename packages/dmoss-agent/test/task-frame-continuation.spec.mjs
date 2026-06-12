#!/usr/bin/env node
/**
 * Working Context / Task Frame continuation tests.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/task-frame-continuation.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
  createOrUpdateTaskFrame,
  detectContinuationIntent,
  recordTaskFrameAssistant,
} from '../dist/core/index.js';

const GUARD_MARKER = '[dmoss-agent] Tool loop guard stopped';

function lastToolResultText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    const block = msg.content.find((b) => b.type === 'tool_result');
    if (block) return String(block.content ?? '');
  }
  return '';
}

class GuardThenResumeProvider {
  constructor() {
    this.id = 'guard-resume';
    this.displayName = 'Guard Resume Provider';
    this.requests = [];
    this.toolRounds = 0;
  }

  async complete() {
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'unused' }] };
  }

  async stream(options) {
    this.requests.push(options);
    const lastToolResult = lastToolResultText(options.messages);
    if (lastToolResult.includes(GUARD_MARKER)) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'paused after guard' }],
      };
    }
    const lastUser = [...options.messages]
      .reverse()
      .find((msg) => msg.role === 'user' && typeof msg.content === 'string');
    if (/继续|continue/i.test(String(lastUser?.content ?? ''))) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'resumed from checkpoint' }],
      };
    }
    this.toolRounds += 1;
    if (this.toolRounds <= 3) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `call_${this.toolRounds}`,
            name: 'preset_probe',
            input: { value: 'same' },
          },
        ],
      };
    }
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
  }
}

function makeProbeTool(calls) {
  return {
    name: 'preset_probe',
    description: 'test probe',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    async execute(input) {
      calls.push(input);
      return `probe:${JSON.stringify(input)}`;
    },
  };
}

async function collect(iterable) {
  const out = [];
  for await (const event of iterable) out.push(event);
  return out;
}

async function withEnv(overrides, fn) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(overrides)) {
    previousEnv[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

assert.deepEqual(detectContinuationIntent('继续'), {
  isContinuation: true,
  isArchiveLookup: false,
});
assert.deepEqual(detectContinuationIntent('请继续'), {
  isContinuation: true,
  isArchiveLookup: false,
});
assert.deepEqual(detectContinuationIntent('请 继续'), {
  isContinuation: true,
  isArchiveLookup: false,
});
assert.deepEqual(detectContinuationIntent('麻烦继续处理'), {
  isContinuation: true,
  isArchiveLookup: false,
});
assert.deepEqual(detectContinuationIntent('不要继续了'), {
  isContinuation: false,
  isArchiveLookup: false,
});
assert.deepEqual(detectContinuationIntent('看上个会话'), {
  isContinuation: false,
  isArchiveLookup: true,
});

const preserved = createOrUpdateTaskFrame({
  previous: {
    schemaVersion: 1,
    sessionKey: 's',
    goal: '孵化桌宠',
    constraints: [],
    currentStep: 'Running attachment_read',
    completedSteps: [],
    pendingSteps: ['Fix read path'],
    artifacts: ['/tmp/run/pet'],
    importantPaths: [],
    toolFindings: [
      {
        toolName: 'attachment_read',
        summary: 'binary fail',
        isError: true,
        at: Date.now(),
      },
    ],
    lastError: 'read err',
    nextAction: 'Resolve or work around the latest read err',
    status: 'paused_resumable',
    source: 'error',
    updatedAt: Date.now(),
  },
  sessionKey: 's',
  runId: 'r2',
  userMessage: '请继续',
});
assert.equal(preserved.nextAction, 'Resolve or work around the latest read err');
assert.equal(preserved.goal, '孵化桌宠');
assert.equal(preserved.status, 'paused_resumable');

const unresolvedAfterAnswer = recordTaskFrameAssistant(
  {
    schemaVersion: 1,
    sessionKey: 's',
    runId: 'r3',
    goal: '修复部署流程并验证',
    constraints: [],
    currentStep: 'Inspect failure',
    completedSteps: ['Read deployment logs'],
    pendingSteps: ['Run validation command'],
    artifacts: [],
    importantPaths: [],
    toolFindings: [],
    nextAction: 'Run validation command',
    status: 'active',
    source: 'user',
    updatedAt: Date.now(),
  },
  '我已经整理了排查结论',
  'end_turn',
  Date.now(),
);
assert.equal(
  unresolvedAfterAnswer.status,
  'paused_resumable',
  'assistant end_turn must not mark a task complete while explicit pending steps remain',
);
assert.deepEqual(unresolvedAfterAnswer.pendingSteps, ['Run validation command']);
assert.match(unresolvedAfterAnswer.nextAction, /Run validation command/);

const provider = new GuardThenResumeProvider();
const store = new InMemorySessionStore();
const calls = [];
const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: store,
  domainPrompt: false,
  enableCompaction: false,
  enableContextPruning: false,
  maxAgentTurns: 8,
});
agent.tools.register(makeProbeTool(calls));

const firstEvents = await withEnv(
  { DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: '2' },
  () => collect(agent.streamChat('task-frame-session', '孵化一个小地瓜桌宠')),
);
assert.ok(
  firstEvents.some(
    (event) => event.type === 'working_context_checkpoint' && event.reason === 'tool_loop_guard',
  ),
  'tool-loop guard should persist a resumable working-context checkpoint',
);

const checkpointMessages = await store.loadMessages('task-frame-session');
const serialized = JSON.stringify(checkpointMessages);
assert.match(serialized, /dmoss_working_context_checkpoint/);
assert.match(serialized, /paused_resumable/);

const secondEvents = await collect(agent.streamChat('task-frame-session', '继续'));
assert.equal(secondEvents.at(-1)?.type, 'done');
const resumeRequest = provider.requests.at(-1);
assert.match(resumeRequest.systemPrompt, /<dmoss_working_context>/);
assert.match(resumeRequest.systemPrompt, /Continuation intent: yes/);
assert.match(resumeRequest.systemPrompt, /Paused at preset_probe guard/);
assert.doesNotMatch(resumeRequest.systemPrompt, /conversation_search.*当前任务/);

console.log('task-frame continuation tests passed');
