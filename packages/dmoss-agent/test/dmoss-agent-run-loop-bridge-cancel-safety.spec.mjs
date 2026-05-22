#!/usr/bin/env node
/**
 * Parity tests for DmossAgent.streamChat -> runAgentLoop bridge:
 * cancellation and pre-tool safety blocking.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-run-loop-bridge-cancel-safety.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  clearPreToolHooksForTests,
  DmossAgent,
  InMemorySessionStore,
  registerPreToolHook,
} from '../dist/core/index.js';

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

function createBridgeAgent(config) {
  return new DmossAgent({
    sessionStore: new InMemorySessionStore(),
    model: 'fake-model',
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns: 4,
    ...config,
  });
}

async function collectBridgeEvents(agent, sessionKey, prompt, options = {}) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, prompt, {
    ...options,
  })) {
    events.push(event);
  }
  return events;
}

{
  const abortController = new AbortController();
  let providerEntered = false;
  const { provider, requests } = createModelEventProvider(async (options) => {
    providerEntered = true;
    abortController.abort(new Error('test abort'));
    assert.equal(options.abortSignal.aborted, true);
    throw new Error('aborted by test');
  });
  const agent = createBridgeAgent({ llmProvider: provider });

  const events = await collectBridgeEvents(
    agent,
    'bridge-cancel',
    'cancel while running',
    { abortSignal: abortController.signal },
  );

  assert.equal(providerEntered, true, 'expected provider stream to start before abort handling');
  assert.equal(requests.length, 1);
  assert.equal(
    events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''),
    '',
    'cancelled bridge should not stream a normal final answer',
  );
  assert(
    events.some((event) => event.type === 'error') ||
      events.some((event) => event.type === 'turn_end') ||
      events.find((event) => event.type === 'done')?.result.stopReason === 'aborted_by_user',
    'expected cancellation to surface through error/turn-related events or done.stopReason',
  );
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event after cancellation');
  assert.notEqual(done.result.response, 'normal final answer');
  assert.equal(done.result.stopReason, 'aborted_by_user');
}

{
  clearPreToolHooksForTests();
  const unregister = registerPreToolHook(async ({ toolName, input }) => {
    if (toolName !== 'danger_probe') return { ok: true, input };
    return { ok: false, message: 'blocked by safety pre-hook' };
  });

  try {
    let executeCount = 0;
    const { provider, requests } = createModelEventProvider((options) => {
      const hasToolResult = options.messages.some((message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
      );
      if (!hasToolResult) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'danger-call-1',
              name: 'danger_probe',
              input: { command: 'rm -rf /tmp/nope' },
            },
          ],
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'blocked follow-up' }],
        usage: { inputTokens: 4, outputTokens: 5 },
      };
    });
    const agent = createBridgeAgent({ llmProvider: provider });
    agent.tools.register({
      name: 'danger_probe',
      description: 'Danger probe',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      async execute() {
        executeCount += 1;
        return 'executed';
      },
    });

    const events = await collectBridgeEvents(
      agent,
      'bridge-safety-pre-hook',
      'use blocked tool',
    );

    assert.equal(executeCount, 0, 'blocked tool must not execute');
    assert.equal(requests.length, 2, 'expected follow-up LLM request after blocked tool result');
    assert(events.some((event) => event.type === 'tool_start' && event.toolName === 'danger_probe'));
    assert(
      events.some(
        (event) =>
          event.type === 'tool_end' &&
          event.toolName === 'danger_probe' &&
          event.isError === true &&
          event.result.includes('blocked by safety pre-hook'),
      ),
      'expected blocked tool_end error event',
    );

    const done = events.find((event) => event.type === 'done');
    assert(done, 'expected done event');
    assert.equal(done.result.response, 'blocked follow-up');
    assert.equal(done.result.toolResults.length, 1);
    assert.equal(done.result.toolResults[0].isError, true);
    assert.match(done.result.toolResults[0].content, /blocked by safety pre-hook/);
  } finally {
    unregister();
    clearPreToolHooksForTests();
  }
}

{
  const toolAbortController = new AbortController();
  const { provider } = createModelEventProvider((options) => {
    const hasToolResult = options.messages.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result'),
    );
    if (!hasToolResult) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'slow-call-1',
            name: 'slow_probe',
            input: { value: 1 },
          },
        ],
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'saw per-tool abort' }],
      usage: { inputTokens: 4, outputTokens: 5 },
    };
  });
  const agent = createBridgeAgent({ llmProvider: provider });
  let executeStarted = false;
  let toolSawSignal = false;
  agent.tools.register({
    name: 'slow_probe',
    description: 'Slow probe',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    },
    async execute(_input, ctx) {
      executeStarted = true;
      toolSawSignal = Boolean(ctx.abortSignal);
      await new Promise((resolve, reject) => {
        ctx.abortSignal?.addEventListener('abort', () => reject(new Error('tool aborted')), {
          once: true,
        });
      });
      return 'should not finish';
    },
  });

  const events = [];
  for await (const event of agent.streamChat('bridge-per-tool-abort', 'run slow tool', {
    toolAbortSignalFor: (toolCallId) =>
      toolCallId === 'slow-call-1' ? toolAbortController.signal : undefined,
  })) {
    events.push(event);
    if (event.type === 'tool_start' && event.toolCallId === 'slow-call-1') {
      toolAbortController.abort(new Error('cancel only this tool'));
    }
  }

  assert.equal(executeStarted, true, 'expected slow tool to start');
  assert.equal(toolSawSignal, true, 'expected bridge to pass per-tool abort signal to tool context');
  const toolEnd = events.find((event) => event.type === 'tool_end' && event.toolName === 'slow_probe');
  assert(toolEnd, 'expected tool_end after per-tool abort');
  assert.equal(toolEnd.isError, true);
  assert.deepEqual(toolEnd.aborted, { by: 'user' });
  assert.match(toolEnd.result, /aborted_by_user|cancelled/i);
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done after per-tool abort follow-up');
  assert.equal(done.result.response, 'saw per-tool abort');
  assert.deepEqual(done.result.toolResults[0].aborted, { by: 'user' });
}

console.log('[PASS] DmossAgent runAgentLoop bridge handles cancel and safety blocking');
