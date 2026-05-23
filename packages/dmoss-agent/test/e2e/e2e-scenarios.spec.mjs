#!/usr/bin/env node
/**
 * D.1-D.3 — E2E scenario tests using deterministic LLM transcripts.
 *
 * Three scenarios:
 *   1. Simple chat (3-turn conversation)
 *   2. Tool use cycle (read_file)
 *   3. Mesh peer discovery (mesh_discover)
 *
 * Each scenario replays a fixed transcript through a DmossAgent with a
 * mock LLM provider. We verify the agent produces the expected responses,
 * executes tool calls, and the final event is 'done'.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/e2e/e2e-scenarios.spec.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { DmossAgent } from '../../dist/core/dmoss-agent.js';
import { InMemorySessionStore } from '../../dist/core/session.js';
import { createMockTranscriptProvider } from './mock-transcript-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
async function loadTranscript(name) {
  const raw = await readFile(path.join(__dirname, 'golden', name), 'utf-8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
}

// ── Scenario 1: Simple chat (3 turns) ────────────────────────────

{
  const transcript = await loadTranscript('chat.jsonl');
  const mockLLM = createMockTranscriptProvider('mock', 'Mock LLM', transcript);
  const store = new InMemorySessionStore();

  const agent = new DmossAgent({
    llmProvider: mockLLM,
    sessionStore: store,
    domainPrompt: false,
    baseSystemPrompt: 'You are a test agent.',
    enableFollowUpGuard: false,
    enableSteering: false,
  });

  const r1 = await agent.chat('sess-1', 'Hello');
  assert.ok(r1.response.length > 0, 'chat: turn 1 should have response');
  assert.ok(r1.response.includes('D-Moss') || r1.response.includes('assistant') || r1.response.includes('Hi'),
    'chat: response should be friendly');

  const r2 = await agent.chat('sess-1', 'What is 2+2');
  assert.ok(r2.response.includes('4'), 'chat: turn 2 should answer math');

  const r3 = await agent.chat('sess-1', 'Tell me about robotics');
  assert.ok(r3.response.length > 0, 'chat: turn 3 should have response');

  console.log('  [PASS] E2E scenario 1: simple chat (3 turns)');
}

// ── Scenario 2: Tool use cycle (read_file) ───────────────────────

{
  const transcript = await loadTranscript('tool-use.jsonl');
  const mockLLM = createMockTranscriptProvider('mock', 'Mock LLM', transcript);
  const store = new InMemorySessionStore();

  const agent = new DmossAgent({
    llmProvider: mockLLM,
    sessionStore: store,
    domainPrompt: false,
    baseSystemPrompt: 'You are a test agent with file tools.',
    enableFollowUpGuard: false,
    enableSteering: false,
  });

  const result = await agent.chat('sess-2', 'read the file /tmp/test.txt');

  // Should have tool calls in the result
  const hasToolActivity = result.toolCalls.length > 0 || result.toolResults.length > 0;
  assert.ok(hasToolActivity, 'tool-use: should have tool calls or tool results');
  assert.ok(result.response.length > 0, 'tool-use: should have final response');
  assert.equal(result.stopReason, 'end_turn', 'tool-use: should end normally');

  // At least one tool result should reference read_file or file content
  const hasReadResult = result.toolResults.some((tr) =>
    tr.result?.includes('test.txt') || tr.result?.includes('configuration')
  ) || result.toolCalls.some((tc) => tc.name === 'read_file');
  assert.ok(hasReadResult, 'tool-use: should have read_file tool activity');

  console.log('  [PASS] E2E scenario 2: tool use cycle');
}

// ── Scenario 3: Mesh peer discovery ──────────────────────────────

{
  const transcript = await loadTranscript('mesh.jsonl');
  const mockLLM = createMockTranscriptProvider('mock', 'Mock LLM', transcript);
  const store = new InMemorySessionStore();

  /** @type {import('../../dist/core/tool-types.js').Tool} */
  const mockMeshDiscover = {
    name: 'mesh_discover',
    description: 'Discover a D-Moss peer agent at a specific address.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Peer hostname or IP' },
        port: { type: 'number', description: 'Peer mesh port' },
      },
      required: ['host'],
    },
    async execute(input) {
      return `Discovered: robot-arm-1 — capabilities: manipulation, navigation`;
    },
  };

  const agent = new DmossAgent({
    llmProvider: mockLLM,
    sessionStore: store,
    domainPrompt: false,
    baseSystemPrompt: 'You are a test agent with mesh tools.',
    enableFollowUpGuard: false,
    enableSteering: false,
  });

  const result = await agent.chat('sess-3', 'discover peer at 192.168.1.100', {
    ephemeralTools: [mockMeshDiscover],
  });

  const hasToolActivity = result.toolCalls.length > 0 || result.toolResults.length > 0;
  assert.ok(hasToolActivity, 'mesh: should have tool calls or tool results');
  assert.ok(result.response.length > 0, 'mesh: should have final response');
  assert.ok(
    result.response.includes('robot-arm-1') ||
    result.response.includes('discovered') ||
    result.toolResults.some((tr) => tr.result?.includes('robot-arm-1')),
    'mesh: response should mention discovered peer',
  );

  console.log('  [PASS] E2E scenario 3: mesh peer discovery');
}

// ── Scenario 4: Event stream completeness ────────────────────────

{
  const transcript = await loadTranscript('chat.jsonl');
  const mockLLM = createMockTranscriptProvider('mock', 'Mock LLM', transcript);
  const store = new InMemorySessionStore();

  const agent = new DmossAgent({
    llmProvider: mockLLM,
    sessionStore: store,
    domainPrompt: false,
    baseSystemPrompt: 'You are a test agent.',
    enableFollowUpGuard: false,
    enableSteering: false,
  });

  /** @type {Array<{type:string}>} */
  const streamEvents = [];

  await agent.chat('sess-4', 'Hello', {
    onStream: (evt) => streamEvents.push({ type: evt.type }),
  });

  // Stream events should include message_start, content_block_delta, message_stop
  const eventTypes = streamEvents.map((e) => e.type);
  assert.ok(eventTypes.includes('message_start'), 'events: should include message_start');
  assert.ok(eventTypes.includes('message_stop'), 'events: should include message_stop');

  // Should have text content in the stream
  const hasTextDelta = streamEvents.some((e) => e.type === 'content_block_delta');
  assert.ok(hasTextDelta, 'events: should have content_block_delta');

  console.log('  [PASS] E2E scenario 4: event stream completeness');
}

// ── Scenario 5: Regression guard — same transcript = same output ──

{
  async function runDeterministicChat() {
    const transcript = await loadTranscript('chat.jsonl');
    const mockLLM = createMockTranscriptProvider('mock', 'Mock LLM', transcript);
    const store = new InMemorySessionStore();
    const agent = new DmossAgent({
      llmProvider: mockLLM,
      sessionStore: store,
      domainPrompt: false,
      baseSystemPrompt: 'You are a test agent.',
      enableFollowUpGuard: false,
      enableSteering: false,
    });
    const r = await agent.chat('sess-reg', 'Hello');
    return r.response;
  }

  const run1 = await runDeterministicChat();
  const run2 = await runDeterministicChat();

  assert.equal(run1, run2, 'regression: same transcript should produce identical output');
  console.log('  [PASS] E2E scenario 5: regression guard (deterministic replay)');
}

console.log('\n[pass] e2e-scenarios: 5/5');