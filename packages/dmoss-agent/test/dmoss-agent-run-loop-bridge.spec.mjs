#!/usr/bin/env node
/**
 * Self-test for the DmossAgent.streamChat → runAgentLoop bridge.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-run-loop-bridge.spec.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DmossAgent, InMemorySessionStore, JsonlSessionStore } from '../dist/core/index.js';

function createModelEventProvider(handler) {
  const requests = [];
  return {
    requests,
    provider: {
      id: 'fake-provider',
      displayName: 'Fake Provider',
      async complete() {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'summary' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async stream(options, onEvent) {
        requests.push(options);
        return handler(options, onEvent, requests.length);
      },
    },
  };
}

{
  const store = new InMemorySessionStore();
  const { provider, requests } = createModelEventProvider((_options, onEvent) => {
    onEvent({ type: 'content_block_delta', text: 'hello from bridge', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'hello from bridge' }],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns: 3,
  });

  const events = [];
  for await (const event of agent.streamChat('bridge-text', 'hi')) {
    events.push(event);
  }

  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'hello from bridge');
  assert.equal(
    events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''),
    'hello from bridge',
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'fake-model');
  assert(requests[0].systemPrompt.includes('base'));

  const stored = await store.loadMessages('bridge-text');
  assert(stored.some((message) => message.role === 'assistant'));
}

{
  const sessionKey = 'bridge-prune-summary';
  const store = new InMemorySessionStore();
  await store.appendMessage(sessionKey, {
    role: 'user',
    content: 'critical old instruction: keep /opt/rdk/calib.yaml in context',
  });
  await store.appendMessage(sessionKey, {
    role: 'assistant',
    content: 'acknowledged old instruction',
  });
  await store.appendMessage(sessionKey, {
    role: 'user',
    content: 'large historical payload ' + 'x'.repeat(80_000),
  });

  const { provider, requests } = createModelEventProvider((_options, onEvent) => {
    onEvent({ type: 'content_block_delta', text: 'continued with compacted context', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'continued with compacted context' }],
      usage: { inputTokens: 2, outputTokens: 3 },
    };
  });
  const completeCalls = [];
  provider.complete = async (request) => {
    completeCalls.push(request);
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: '<summary>summary preserved /opt/rdk/calib.yaml</summary>' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    contextTokens: 20_000,
    maxTokens: 1_000,
    maxAgentTurns: 2,
    pruningSettings: {
      maxHistoryShare: 0.1,
      keepLastAssistants: 1,
      softTrimRatio: 1,
      hardClearRatio: 1,
    },
    compactionSettings: {
      enabled: true,
      reserveTokens: 1,
      keepRecentTokens: 1,
    },
  });

  const events = [];
  for await (const event of agent.streamChat(sessionKey, 'continue from earlier instruction')) {
    events.push(event);
  }

  assert(completeCalls.length >= 1, 'prompt-level prune must force a summary before dropping history');
  assert.equal(requests.length, 1);
  assert(
    requests[0].messages.some((message) =>
      typeof message.content === 'string' &&
      message.content.includes('summary preserved /opt/rdk/calib.yaml'),
    ),
    'provider request should include compaction summary instead of silently dropping old context',
  );
  const persisted = await store.loadMessages(sessionKey);
  assert(
    persisted.some((message) =>
      typeof message.content === 'string' &&
      message.content.includes('summary preserved /opt/rdk/calib.yaml'),
    ),
    'compacted summary should be persisted into active JSONL state',
  );
  const compactionEvent = events.find((event) => event.type === 'compaction');
  assert(compactionEvent, 'compaction should emit a visible event for UI');
  assert(
    Array.isArray(compactionEvent.checkpointOutline) && compactionEvent.checkpointOutline.length > 0,
    'compaction UI event should expose safe checkpoint coverage',
  );
  assert(events.some((event) => event.type === 'done'));
}

{
  const store = new InMemorySessionStore();
  const seenToolResults = [];
  const { provider, requests } = createModelEventProvider((options) => {
    const hasToolResult = options.messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
    );
    if (!hasToolResult) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'call-1', name: 'probe', input: { value: 7 } }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'tool says ok' }],
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 4,
    hooks: {
      onToolResult(call, result) {
        seenToolResults.push({ call, result });
      },
    },
  });
  agent.tools.register({
    name: 'probe',
    description: 'Probe',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    async execute(input) {
      return `ok:${input.value}`;
    },
  });

  const events = [];
  for await (const event of agent.streamChat('bridge-tool', 'use tool')) {
    events.push(event);
  }

  assert(events.some((event) => event.type === 'tool_start' && event.toolName === 'probe'));
  assert(events.some((event) => event.type === 'tool_end' && event.result.includes('ok:7')));
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'tool says ok');
  assert.equal(done.result.toolCalls.length, 1);
  assert.equal(done.result.toolResults.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(seenToolResults.length, 1);
  assert.equal(seenToolResults[0].call.name, 'probe');
}

{
  const store = new InMemorySessionStore();
  const { provider } = createModelEventProvider(() => ({
    stopReason: 'end_turn',
    content: [{ type: 'text', text: 'collected chat result' }],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 3,
  });

  const result = await agent.chat('bridge-chat', 'hi');
  assert.equal(result.response, 'collected chat result');
  assert.equal(result.stopReason, 'end_turn');
}

{
  const store = new InMemorySessionStore();
  const lifecycle = {
    requestStarts: [],
    responseEnds: [],
    streamEvents: [],
    turnCompletes: [],
    toolResults: [],
    enrichContexts: [],
  };
  const longResult = `long:${'x'.repeat(900)}`;
  const { provider } = createModelEventProvider((options, onEvent) => {
    const hasToolResult = options.messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
    );
    if (!hasToolResult) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'long-call-1', name: 'long_probe', input: { value: 3 } }],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    onEvent({ type: 'content_block_delta', text: 'after long tool', deltaRole: 'visible' });
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'after long tool' }],
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    maxAgentTurns: 4,
    hooks: {
      onLLMRequestStart(info) {
        lifecycle.requestStarts.push(info);
      },
      onLLMResponseEnd(response) {
        lifecycle.responseEnds.push(response);
      },
      onStream(event) {
        lifecycle.streamEvents.push(event);
      },
      onTurnComplete(info) {
        lifecycle.turnCompletes.push(info);
      },
      onToolResult(call, result) {
        lifecycle.toolResults.push({ call, result });
      },
      enrichToolContext(baseCtx) {
        lifecycle.enrichContexts.push({
          toolCallId: baseCtx.toolCallId,
          hasAbortSignal: Boolean(baseCtx.abortSignal),
        });
        return { ...baseCtx, injectedByTest: true };
      },
    },
  });
  agent.tools.register({
    name: 'long_probe',
    description: 'Long probe',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    async execute(_input, ctx) {
      assert.equal(ctx.injectedByTest, true);
      return longResult;
    },
  });

  const events = [];
  for await (const event of agent.streamChat('bridge-hooks-full-result', 'run long tool')) {
    events.push(event);
  }

  const toolEnd = events.find((event) => event.type === 'tool_end' && event.toolName === 'long_probe');
  assert(toolEnd, 'expected tool_end event');
  assert(toolEnd.result.length < longResult.length, 'UI tool_end should remain a preview');
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  assert.equal(done.result.response, 'after long tool');
  assert.equal(done.result.toolResults[0].content, longResult);

  assert.equal(lifecycle.requestStarts.length, 2);
  assert.equal(lifecycle.requestStarts[0].model, 'fake-model');
  assert.equal(lifecycle.requestStarts[0].toolCount, 1);
  assert.equal(lifecycle.responseEnds.length, 2);
  assert(
    lifecycle.streamEvents.some((event) => event.type === 'content_block_delta' && event.text === 'after long tool'),
    'expected provider stream events to reach hooks.onStream',
  );
  assert(lifecycle.turnCompletes.length >= 1, 'expected turn completion hook');
  assert.equal(lifecycle.toolResults.length, 1);
  assert.equal(lifecycle.toolResults[0].result.content, longResult);
  assert.deepEqual(lifecycle.enrichContexts[0], {
    toolCallId: 'long-call-1',
    hasAbortSignal: true,
  });
}

{
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dmoss-bridge-jsonl-'));
  try {
    const sessionKey = 'bridge-jsonl-roundtrip';
    const store = new JsonlSessionStore({ dir });
    const { provider } = createModelEventProvider((options) => {
      const hasToolResult = options.messages.some((message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
      );
      if (!hasToolResult) {
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'jsonl-call-1', name: 'jsonl_probe', input: { value: 11 } }],
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'jsonl persisted' }],
        usage: { inputTokens: 4, outputTokens: 5 },
      };
    });
    const agent = new DmossAgent({
      llmProvider: provider,
      sessionStore: store,
      model: 'fake-model',
      domainPrompt: false,
      includeRegisteredKnowledgePrompts: false,
      maxAgentTurns: 4,
    });
    agent.tools.register({
      name: 'jsonl_probe',
      description: 'JSONL persistence probe',
      inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
      async execute(input) {
        return `jsonl:${input.value}`;
      },
    });

    for await (const _event of agent.streamChat(sessionKey, 'persist tool roundtrip')) {
      // Drain stream.
    }

    const reloaded = await new JsonlSessionStore({ dir }).loadMessages(sessionKey);
    assert(
      reloaded.some((message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_use' && block.id === 'jsonl-call-1'),
      ),
      'expected assistant tool_use to survive JSONL reload',
    );
    assert(
      reloaded.some((message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) =>
            block.type === 'tool_result' &&
            block.tool_use_id === 'jsonl-call-1' &&
            block.content === 'jsonl:11' &&
            block.is_error === false,
        ),
      ),
      'expected user tool_result to survive JSONL reload',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('[PASS] DmossAgent runAgentLoop bridge streams text and tools');
