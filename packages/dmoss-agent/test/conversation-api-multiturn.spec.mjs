#!/usr/bin/env node
/**
 * Local multi-turn conversation API regression tests.
 *
 * These tests exercise DmossAgent.streamChat() through the PiAiLLMProvider
 * boundary so we can inspect the provider-facing payload across repeated
 * conversations without depending on a live model or network.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/conversation-api-multiturn.spec.mjs
 */

import assert from 'node:assert/strict';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';
import { PiAiLLMProvider } from '../dist/provider/index.js';

function modelInfo({ reasoning = 'high' } = {}) {
  return {
    api: 'openai-chat',
    provider: 'conversation-api-test',
    id: 'conversation-api-test-model',
    ...(reasoning ? { reasoning } : {}),
  };
}

function createPiAgent({
  reasoning = 'high',
  modelReasoning = reasoning,
  streamPlan,
  maxAgentTurns = 5,
} = {}) {
  const calls = [];
  let callIndex = 0;
  const provider = new PiAiLLMProvider({
    apiKey: 'test-key',
    model: modelInfo({ reasoning: modelReasoning }),
    ...(reasoning !== undefined ? { reasoning } : {}),
    streamFn: async function* (model, context, options) {
      calls.push({ model, context, options });
      const step = streamPlan[callIndex++];
      assert(step, `missing stream plan for provider call ${callIndex}`);
      for (const event of step({ model, context, options, callIndex })) {
        yield event;
      }
    },
  });
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'conversation-api-test-model',
    reasoning: reasoning || null,
    domainPrompt: false,
    includeRegisteredKnowledgePrompts: false,
    baseSystemPrompt: 'base',
    maxAgentTurns,
    enableCompaction: false,
    enableContextPruning: false,
  });
  return { agent, calls };
}

function* textTurn({ thinking, text }) {
  if (thinking) yield { type: 'thinking_delta', thinking };
  if (text) yield { type: 'text_delta', text };
  yield { type: 'done', stopReason: 'stop' };
}

function* toolTurn({ thinking, id = 'call_probe', name = 'local_probe', args = {} }) {
  if (thinking) yield { type: 'thinking_delta', thinking };
  yield {
    type: 'done',
    stopReason: 'toolCall',
    message: {
      content: [
        ...(thinking ? [{ type: 'thinking', thinking }] : []),
        { type: 'toolCall', id, name, arguments: args },
      ],
    },
  };
}

async function collect(agent, sessionKey, message) {
  const events = [];
  for await (const event of agent.streamChat(sessionKey, message)) {
    events.push(event);
  }
  const done = events.find((event) => event.type === 'done');
  assert(done, 'expected done event');
  return { events, done };
}

function assistantMessages(call) {
  return call.context.messages.filter((msg) => msg.role === 'assistant');
}

function assistantHasThinking(call) {
  return assistantMessages(call).some(
    (msg) => Array.isArray(msg.content) && msg.content.some((block) => block.type === 'thinking'),
  );
}

async function testThinkingModelReplaysReasoningAcrossNormalTurns() {
  const { agent, calls } = createPiAgent({
    streamPlan: [
      () => textTurn({ thinking: 'first hidden plan', text: '你好，我在。' }),
      () => textTurn({ thinking: 'second hidden plan', text: '可以继续。' }),
      () => textTurn({ thinking: 'third hidden plan', text: '已总结。' }),
    ],
  });

  await collect(agent, 'thinking-normal', '你好');
  await collect(agent, 'thinking-normal', '/pet 生成一个桌宠');
  await collect(agent, 'thinking-normal', '总结一下上下文');

  assert.equal(calls.length, 3);
  assert.equal(assistantHasThinking(calls[0]), false, 'first request has no prior assistant');
  assert.equal(assistantHasThinking(calls[1]), true, 'second request should replay reasoning');
  assert.equal(
    assistantHasThinking(calls[2]),
    true,
    'third request should keep replaying reasoning',
  );
  assert.equal(calls[1].model.reasoning, 'high');
  assert.equal(calls[2].model.reasoning, 'high');
  console.log('  [PASS] thinking model replays reasoning across normal multi-turn chat');
}

async function testNonThinkingModelDoesNotReplayReasoningAcrossNormalTurns() {
  const { agent, calls } = createPiAgent({
    reasoning: null,
    modelReasoning: null,
    streamPlan: [
      () => textTurn({ thinking: 'provider emitted hidden plan', text: '你好。' }),
      () => textTurn({ thinking: 'another hidden plan', text: '继续。' }),
    ],
  });

  await collect(agent, 'non-thinking-normal', '你好');
  await collect(agent, 'non-thinking-normal', '继续');

  assert.equal(calls.length, 2);
  assert.equal(
    assistantHasThinking(calls[1]),
    false,
    'non-thinking provider calls should not receive prior reasoning blocks',
  );
  assert.equal(Boolean(calls[1].model.reasoning), false);
  console.log('  [PASS] non-thinking model strips reasoning from normal multi-turn chat');
}

async function testToolFollowupKeepsReasoningButSuppressesNewReasoning() {
  const { agent, calls } = createPiAgent({
    streamPlan: [
      () => toolTurn({ thinking: 'tool planning', args: { query: '桌宠' } }),
      () => textTurn({ text: '工具结果已整理。' }),
    ],
  });
  const executed = [];
  agent.tools.register({
    name: 'local_probe',
    description: 'Local probe tool',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    async execute(input) {
      executed.push(input);
      return 'probe result';
    },
  });

  const { done } = await collect(agent, 'thinking-tool', '先查一下再回答');

  assert.equal(done.result.response, '工具结果已整理。');
  assert.deepEqual(executed, [{ query: '桌宠' }]);
  assert.equal(calls.length, 2);
  assert.equal(
    assistantHasThinking(calls[1]),
    true,
    'tool follow-up request should pass back prior assistant reasoning',
  );
  assert.equal(
    calls[1].model.reasoning,
    'high',
    'tool follow-up should retain provider model marker for reasoning history',
  );
  assert.equal(
    calls[1].options.reasoning,
    undefined,
    'tool follow-up should omit new reasoning effort',
  );
  console.log('  [PASS] tool follow-up keeps prior reasoning while suppressing new reasoning');
}

async function testFailedProviderTurnDoesNotPoisonLaterConversation() {
  const { agent, calls } = createPiAgent({
    streamPlan: [
      () => textTurn({ thinking: 'stable hidden plan', text: '第一轮完成。' }),
      function* () {
        yield {
          type: 'error',
          error: {
            status: 400,
            errorMessage:
              '400 The reasoning_content in the thinking mode must be passed back to the API.',
          },
        };
      },
      () => textTurn({ thinking: 'recovery hidden plan', text: '恢复成功。' }),
    ],
  });

  await collect(agent, 'failure-recovery', '第一轮');
  // Per-turn error recovery: the agent catches the error internally,
  // injects a correction message, and re-calls the LLM — self-healing
  // without propagating the error to the caller.
  const { done } = await collect(agent, 'failure-recovery', '触发一次失败');

  assert.equal(done.result.response, '恢复成功。');
  assert.equal(calls.length, 3);
  assert.equal(
    assistantHasThinking(calls[2]),
    true,
    'recovery request should still have intact prior reasoning history',
  );
  console.log('  [PASS] failed provider turn does not poison later conversation history');
}

async function testSessionsStayIsolated() {
  const { agent, calls } = createPiAgent({
    streamPlan: [
      () => textTurn({ thinking: 'session a hidden plan', text: 'A1' }),
      () => textTurn({ thinking: 'session b hidden plan', text: 'B1' }),
      () => textTurn({ thinking: 'session a second plan', text: 'A2' }),
    ],
  });

  await collect(agent, 'session-a', 'A 第一轮');
  await collect(agent, 'session-b', 'B 第一轮');
  await collect(agent, 'session-a', 'A 第二轮');

  assert.equal(calls.length, 3);
  const thirdUserTexts = calls[2].context.messages
    .filter((msg) => msg.role === 'user')
    .map((msg) => (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)))
    .join('\n');
  assert.match(thirdUserTexts, /A 第一轮/);
  assert.doesNotMatch(thirdUserTexts, /B 第一轮/);
  assert.equal(assistantHasThinking(calls[2]), true);
  console.log('  [PASS] repeated local conversation API calls keep sessions isolated');
}

await testThinkingModelReplaysReasoningAcrossNormalTurns();
await testNonThinkingModelDoesNotReplayReasoningAcrossNormalTurns();
await testToolFollowupKeepsReasoningButSuppressesNewReasoning();
await testFailedProviderTurnDoesNotPoisonLaterConversation();
await testSessionsStayIsolated();

console.log('conversation API multi-turn tests passed');
