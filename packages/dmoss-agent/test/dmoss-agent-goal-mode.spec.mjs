#!/usr/bin/env node
/**
 * DmossAgent goal mode integration tests.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/dmoss-agent-goal-mode.spec.mjs
 */

import assert from 'node:assert/strict';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';

function createProvider() {
  const requests = [];
  return {
    requests,
    provider: {
      id: 'goal-mode-provider',
      displayName: 'Goal Mode Provider',
      async complete() {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'summary' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async stream(options) {
        requests.push(options);
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'goal-aware reply' }],
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
    },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const sessionKey = 'goal-mode-session';
const store = new InMemorySessionStore();
const { provider, requests } = createProvider();
const agent = new DmossAgent({
  llmProvider: provider,
  sessionStore: store,
  model: 'fake-model',
  domainPrompt: false,
  includeRegisteredKnowledgePrompts: false,
  baseSystemPrompt: 'base',
  maxAgentTurns: 2,
});

const created = await agent.setGoal(sessionKey, '  Stabilize Host Adapter v1 and golden E2E  ');
assert.equal(created.objective, 'Stabilize Host Adapter v1 and golden E2E');
assert.equal(created.status, 'active');

const loaded = await agent.getGoal(sessionKey);
assert.equal(loaded?.objective, created.objective);
assert.equal(loaded?.status, 'active');

await collect(agent.streamChat(sessionKey, 'continue the work'));
assert.equal(requests.length, 1);
assert.match(requests[0].systemPrompt, /<dmoss_goal_mode>/);
assert.match(requests[0].systemPrompt, /Stabilize Host Adapter v1 and golden E2E/);
assert.match(requests[0].systemPrompt, /Status: active/);

const paused = await agent.pauseGoal(sessionKey, 'waiting for RDK Studio review');
assert.equal(paused?.status, 'paused');
assert.equal(paused?.statusReason, 'waiting for RDK Studio review');

await collect(agent.streamChat(sessionKey, 'what is next?'));
assert.equal(requests.length, 2);
assert.match(requests[1].systemPrompt, /Status: paused/);
assert.match(requests[1].systemPrompt, /waiting for RDK Studio review/);

const resumed = await agent.resumeGoal(sessionKey);
assert.equal(resumed?.status, 'active');
assert.equal(resumed?.statusReason, undefined);

const blocked = await agent.blockGoal(sessionKey, 'missing fixture host contract');
assert.equal(blocked?.status, 'blocked');
assert.equal(blocked?.statusReason, 'missing fixture host contract');

const completed = await agent.completeGoal(sessionKey, 'verified');
assert.equal(completed?.status, 'completed');
assert.equal(completed?.statusReason, 'verified');

await agent.clearGoal(sessionKey);
assert.equal(await agent.getGoal(sessionKey), undefined);

await collect(agent.streamChat(sessionKey, 'fresh request'));
assert.equal(requests.length, 3);
assert.doesNotMatch(requests[2].systemPrompt, /<dmoss_goal_mode>/);

const stored = await store.loadMessages(sessionKey);
assert.equal(
  JSON.stringify(stored).includes('dmoss_goal_checkpoint'),
  false,
  'goal checkpoints must not leak into active chat history after clearGoal()',
);

console.log('dmoss-agent goal mode tests passed');
