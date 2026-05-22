#!/usr/bin/env node
/**
 * Self-test for SummarizationStrategy adapters.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/summarization-strategy.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  createClientLlmSummarizationStrategy,
  createProviderServerCompactionStrategy,
  createSummarizeFnFromLlmProvider,
} from '../dist/core/index.js';

const messages = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `message ${i}`,
  timestamp: i + 1,
}));

{
  const calls = [];
  const summarize = async (request) => {
    calls.push(request);
    return '<summary>folded context</summary>';
  };
  const strategy = createClientLlmSummarizationStrategy({ summarize });
  const result = await strategy.compact({
    messages,
    contextWindowTokens: 10_000,
    compactionSettings: { reserveTokens: 200 },
    forceCompaction: true,
  });

  assert.equal(strategy.kind, 'client_llm');
  assert.equal(result.kind, 'client_summary');
  assert.equal(result.source, 'client_llm');
  assert.equal(result.summary, 'folded context');
  assert.equal(result.summaryMessage.role, 'user');
  assert.match(result.summaryMessage.content, /folded context/);
  assert.equal(result.pruneResult.droppedMessages.length, 2);
  assert.equal(calls.length, 1);
}

{
  const strategy = createClientLlmSummarizationStrategy({
    summarize: async () => {
      throw new Error('summarize should not run when LLM compaction is skipped');
    },
  });
  const result = await strategy.compact({
    messages,
    contextWindowTokens: 10_000,
    forceCompaction: true,
    skipLlmCompaction: true,
  });

  assert.equal(result.kind, 'client_summary');
  assert.equal(result.source, 'client_llm');
  assert.equal(result.pruneResult.droppedMessages.length, 2);
  assert.match(result.summary, /本地规则生成/);
  assert.match(result.summaryMessage.content, /本地规则生成/);
}

{
  const strategy = createClientLlmSummarizationStrategy({
    summarize: async () => {
      throw new Error('summary provider unavailable');
    },
  });
  const result = await strategy.compact({
    messages: [
      { role: 'user', content: 'critical user constraint: keep camera path /dev/video0', timestamp: 1 },
      ...messages,
    ],
    contextWindowTokens: 10_000,
    forceCompaction: true,
  });

  assert.equal(result.kind, 'client_summary');
  assert.equal(result.source, 'client_llm');
  assert.match(result.summary, /critical user constraint/);
  assert.match(result.summary, /本地规则摘要兜底/);
}

{
  const completeCalls = [];
  const provider = {
    async complete(request) {
      completeCalls.push(request);
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'text', text: 'part-a' },
          { type: 'tool_use', id: 'ignored', name: 'noop', input: {} },
          { type: 'text', text: 'part-b' },
        ],
      };
    },
  };
  const summarize = createSummarizeFnFromLlmProvider({ provider, model: 'summary-model' });
  const text = await summarize({
    system: 'system prompt',
    userPrompt: 'conversation',
    maxTokens: 123,
  });

  assert.equal(text, 'part-apart-b');
  assert.equal(completeCalls.length, 1);
  assert.equal(completeCalls[0].model, 'summary-model');
  assert.equal(completeCalls[0].systemPrompt, 'system prompt');
  assert.equal(completeCalls[0].messages[0].content, 'conversation');
  assert.equal(completeCalls[0].maxTokens, 123);
}

{
  const abortController = new AbortController();
  let observedInput;
  const strategy = createProviderServerCompactionStrategy({
    id: 'server-compact-test',
    async compact(input) {
      observedInput = input;
      return {
        encryptedContent: 'opaque-checkpoint',
        raw: { responseId: 'resp_123' },
      };
    },
  });
  const result = await strategy.compact({
    messages,
    contextWindowTokens: 10_000,
    forceCompaction: true,
    abortSignal: abortController.signal,
  });

  assert.equal(strategy.id, 'server-compact-test');
  assert.equal(strategy.kind, 'provider_server_compaction');
  assert.equal(result.kind, 'provider_compaction');
  assert.equal(result.source, 'provider_server_compaction');
  assert.equal(result.compaction.encryptedContent, 'opaque-checkpoint');
  assert.equal(result.compaction.raw.responseId, 'resp_123');
  assert.equal(observedInput.abortSignal, abortController.signal);
}

{
  const strategy = createProviderServerCompactionStrategy({
    async compact() {
      return null;
    },
  });
  const result = await strategy.compact({ messages, contextWindowTokens: 10_000 });

  assert.equal(result.kind, 'none');
  assert.equal(result.source, 'provider_server_compaction');
}

console.log('[PASS] SummarizationStrategy adapters expose client and provider compaction shapes');
