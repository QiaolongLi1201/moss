#!/usr/bin/env node
/**
 * Parity coverage for the DmossAgent.streamChat -> runAgentLoop bridge:
 * working-context checkpoints, TaskFrame resumability, max-turn pressure, and
 * overflow compaction hooks.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-run-loop-bridge-context-taskframe.spec.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CompactHookRegistry,
  COMPACTION_SUMMARY_PREFIX,
  DmossAgent,
  InMemorySessionStore,
  JsonlSessionStore,
} from '../dist/core/index.js';

function createModelEventProvider(handler, completeHandler = undefined) {
  const streamRequests = [];
  const completeRequests = [];
  return {
    streamRequests,
    completeRequests,
    provider: {
      id: 'fake-provider',
      displayName: 'Fake Provider',
      async complete(options) {
        completeRequests.push(options);
        if (completeHandler) return completeHandler(options, completeRequests.length);
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '<summary>bridge summary checkpoint</summary>' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async stream(options, onEvent) {
        streamRequests.push(options);
        return handler(options, onEvent, streamRequests.length);
      },
    },
  };
}

async function collect(iterable) {
  const out = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function checkpointMessages(messages) {
  return messages.filter((message) =>
    JSON.stringify(message).includes('dmoss_working_context_checkpoint'),
  );
}

function parseCheckpoint(message) {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => block.text ?? block.content ?? '').join('\n');
  const match = text.match(
    /<dmoss_working_context_checkpoint[^>]*>\s*([\s\S]*?)\s*<\/dmoss_working_context_checkpoint>/,
  );
  assert(match, 'expected a serialized TaskFrame checkpoint');
  return JSON.parse(match[1]);
}

function countCompactionSummaries(messages) {
  return messages.filter(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.startsWith(COMPACTION_SUMMARY_PREFIX),
  ).length;
}

function makeAgent(config) {
  return new DmossAgent({
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    enableContextPruning: true,
    enableCompaction: true,
    ...config,
  });
}

{
  const store = new InMemorySessionStore();
  const { provider } = createModelEventProvider((_options, onEvent) => {
    onEvent({ type: 'content_block_delta', text: 'bridge completed', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'bridge completed' }],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: store,
    maxAgentTurns: 3,
  });

  const events = await collect(
    agent.streamChat('bridge-context-complete', 'finish and checkpoint', {
      runId: 'run-complete',
    }),
  );

  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'bridge completed');

  const stored = await store.loadMessages('bridge-context-complete');
  const checkpoints = checkpointMessages(stored);
  assert.equal(checkpoints.length, 1, 'bridge should persist one working-context checkpoint');
  const frame = parseCheckpoint(checkpoints[0]);
  assert.equal(frame.schemaVersion, 1);
  assert.equal(frame.sessionKey, 'bridge-context-complete');
  assert.equal(frame.runId, 'run-complete');
  assert.equal(frame.status, 'completed');
  assert.equal(frame.source, 'assistant');
  assert.match(frame.goal, /finish and checkpoint/);
  assert(
    frame.completedSteps.some((step) => step.includes('Assistant response: bridge completed')),
    'TaskFrame should record the final assistant response',
  );
}

{
  const store = new InMemorySessionStore();
  const { provider } = createModelEventProvider((_options, _onEvent, callNumber) => ({
    stopReason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: `call-${callNumber}`,
        name: 'loop_probe',
        input: { turn: callNumber },
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: store,
    maxAgentTurns: 1,
  });
  agent.tools.register({
    name: 'loop_probe',
    description: 'Always succeeds so the fake model can keep requesting tools.',
    inputSchema: {
      type: 'object',
      properties: { turn: { type: 'number' } },
      required: ['turn'],
    },
    async execute(input) {
      return `loop:${input.turn}`;
    },
  });

  const events = await collect(
    agent.streamChat('bridge-context-max-turns', 'keep using the tool', {
      runId: 'run-max-turns',
    }),
  );

  assert(
    events.some((event) => event.type === 'tool_start' && event.toolName === 'loop_probe'),
    'expected bridge to execute tool calls before hitting turn pressure',
  );
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  const checkpoint = events.find((event) => event.type === 'working_context_checkpoint');
  assert(
    checkpoint || done.result.stopReason === 'max_turns_reached',
    'expected a resumable checkpoint or max_turns_reached done reason',
  );

  const stored = await store.loadMessages('bridge-context-max-turns');
  const frame = parseCheckpoint(checkpointMessages(stored).at(-1));
  assert.notEqual(frame.status, 'completed');
  assert.match(frame.goal, /keep using the tool/);
  assert(
    frame.toolFindings.some((finding) => finding.toolName === 'loop_probe'),
    'TaskFrame should retain tool findings for resume',
  );
  assert(
    frame.nextAction && frame.nextAction.length > 0,
    'checkpoint should include a concrete next action for resume',
  );
}

{
  const store = new InMemorySessionStore();
  const gateCalls = [];
  const { provider, streamRequests } = createModelEventProvider((options, onEvent, callNumber) => {
    if (callNumber === 1) {
      onEvent({ type: 'content_block_delta', text: 'premature completion', deltaRole: 'visible' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'premature completion' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    onEvent({ type: 'content_block_delta', text: 'continued with evidence', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'continued with evidence' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: store,
    enableCompaction: false,
    enableContextPruning: false,
    maxAgentTurns: 4,
    completionGate: async ({ response, turn }) => {
      gateCalls.push({ response, turn });
      if (gateCalls.length === 1) {
        return {
          ok: false,
          reason: 'no verification evidence',
          correction: '[System] Completion rejected: run validation before claiming the task is complete.',
        };
      }
      return { ok: true };
    },
  });

  const events = await collect(
    agent.streamChat('bridge-completion-gate', 'finish only after verification', {
      runId: 'run-completion-gate',
    }),
  );

  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'continued with evidence');
  assert.equal(gateCalls.length, 2, 'completion gate should inspect the retry response too');
  assert.equal(streamRequests.length, 2, 'rejected completion should trigger another LLM turn');
  assert(
    !events.some((event) => event.type === 'text_delta' && event.delta.includes('premature completion')),
    'completion-gate rejected text must not stream to the UI before retry',
  );
  assert(
    events.some((event) => event.type === 'text_delta' && event.delta.includes('continued with evidence')),
    'approved completion text should stream after the gate passes',
  );
  assert(
    streamRequests[1].messages.some((message) =>
      JSON.stringify(message).includes('Completion rejected: run validation'),
    ),
    'second LLM request should include the completion-gate correction message',
  );
}

{
  const store = new InMemorySessionStore();
  const { provider } = createModelEventProvider((_options, onEvent) => {
    onEvent({ type: 'content_block_delta', text: 'still claiming completion', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'still claiming completion' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: store,
    enableCompaction: false,
    enableContextPruning: false,
    maxAgentTurns: 5,
    completionGate: async () => ({
      ok: false,
      reason: 'missing validation evidence',
      correction: '[System] Completion rejected: gather validation evidence.',
      fallbackResponse: 'I could not verify completion after retrying; this remains unverified.',
    }),
  });

  const events = await collect(
    agent.streamChat('bridge-completion-gate-exhausted', 'finish only after verification', {
      runId: 'run-completion-gate-exhausted',
    }),
  );

  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event after completion-gate retry exhaustion');
  assert.equal(
    done.result.response,
    'I could not verify completion after retrying; this remains unverified.',
  );
  assert(
    !events.some((event) => event.type === 'text_delta' && event.delta.includes('still claiming completion')),
    'completion-gate exhausted path must not stream the rejected completion claim',
  );
}

{
  const store = new InMemorySessionStore();
  const compactHooks = new CompactHookRegistry();
  const preHooks = [];
  const postHooks = [];
  compactHooks.registerPre(async (ctx) => {
    preHooks.push({
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
      reason: ctx.reason,
      messageCount: ctx.messages.length,
    });
  });
  compactHooks.registerPost(async (ctx) => {
    postHooks.push({ ...ctx });
  });

  const { provider, streamRequests, completeRequests } = createModelEventProvider(
    (_options, _onEvent, callNumber) => {
      if (callNumber === 1) {
        throw new Error('context overflow while building the prompt');
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'recovered after compaction' }],
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
    () => ({
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: [
            '<summary>',
            '## 1. 主要目标',
            'Recover from overflow in the bridge test.',
            '',
            '## 9. 后续工作所需上下文',
            'Continue with the compacted runAgentLoop bridge request.',
            '</summary>',
          ].join('\n'),
        },
      ],
      usage: { inputTokens: 3, outputTokens: 3 },
    }),
  );
  const agent = makeAgent({
    llmProvider: provider,
    sessionStore: store,
    compactHooks,
    contextTokens: 64,
    maxTokens: 8,
    maxAgentTurns: 3,
    compactionSettings: {
      enabled: true,
      reserveTokens: 1,
      keepRecentTokens: 1,
    },
  });

  const events = await collect(
    agent.streamChat('bridge-context-overflow', 'overflow compaction please', {
      runId: 'run-overflow',
    }),
  );

  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event after overflow recovery');
  assert.equal(done.result.response, 'recovered after compaction');
  assert.equal(done.result.compactions, 1);

  assert.equal(preHooks.length, 1);
  assert.equal(preHooks[0].reason, 'overflow');
  assert.equal(preHooks[0].sessionKey, 'bridge-context-overflow');
  assert.equal(preHooks[0].runId, 'run-overflow');
  assert.equal(postHooks.length, 1);
  assert.equal(postHooks[0].reason, 'overflow');
  assert.equal(postHooks[0].success, true);
  assert(postHooks[0].summaryChars > 0);
  assert.equal(completeRequests.length, 1, 'overflow recovery should ask provider.complete to summarize');
  assert(
    streamRequests[1].messages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith(COMPACTION_SUMMARY_PREFIX) &&
        message.content.includes('Recover from overflow in the bridge test.'),
    ),
    'recovered provider request should receive the compaction summary message',
  );
  assert.equal(
    countCompactionSummaries(streamRequests[1].messages),
    1,
    'recovered provider request should not receive duplicate compaction summaries',
  );
  const recoveredCheckpoints = checkpointMessages(streamRequests[1].messages);
  assert.equal(
    recoveredCheckpoints.length,
    1,
    'recovered provider request must receive the live TaskFrame checkpoint after compaction',
  );
  const recoveredFrame = parseCheckpoint(recoveredCheckpoints[0]);
  assert.equal(recoveredFrame.source, 'compaction');
  assert.match(recoveredFrame.goal, /overflow compaction please/);
  assert(
    recoveredFrame.completedSteps.some((step) => step.includes('Saved context checkpoint')),
    'compaction checkpoint should preserve the saved-context step for the next LLM request',
  );
  assert.equal(
    countCompactionSummaries(await store.loadMessages('bridge-context-overflow')),
    1,
    'compacted active history should be persisted to the session store',
  );
}

{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dmoss-bridge-overflow-jsonl-'));
  const sessionKey = 'bridge-jsonl-overflow';
  try {
    const store = new JsonlSessionStore({ dir });
    const { provider, streamRequests } = createModelEventProvider(
      (_options, _onEvent, callNumber) => {
        if (callNumber === 1) {
          throw new Error('context overflow while building the prompt');
        }
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'jsonl recovered after compaction' }],
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      },
      () => ({
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: '<summary>jsonl compacted bridge overflow history</summary>',
          },
        ],
        usage: { inputTokens: 3, outputTokens: 3 },
      }),
    );
    const agent = makeAgent({
      llmProvider: provider,
      sessionStore: store,
      contextTokens: 64,
      maxTokens: 8,
      maxAgentTurns: 3,
      compactionSettings: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 1,
      },
    });

    const events = await collect(
      agent.streamChat(sessionKey, 'jsonl overflow compaction please', {
        runId: 'run-jsonl-overflow',
      }),
    );

    const done = events.find((event) => event.type === 'done');
    assert(done, 'expected done event after JSONL overflow recovery');
    assert.equal(done.result.response, 'jsonl recovered after compaction');
    assert.equal(countCompactionSummaries(streamRequests[1].messages), 1);

    const reloaded = await new JsonlSessionStore({ dir }).loadMessages(sessionKey);
    assert.equal(countCompactionSummaries(reloaded), 1);
    assert(
      reloaded.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('jsonl compacted bridge overflow history'),
      ),
      'JSONL reload should replay compacted active history',
    );
    const raw = await readFile(path.join(dir, `${sessionKey}.jsonl`), 'utf8');
    assert(raw.includes('"type":"state_replace"'), 'JSONL should persist compaction via state_replace');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('[PASS] DmossAgent bridge context and TaskFrame parity tests');
