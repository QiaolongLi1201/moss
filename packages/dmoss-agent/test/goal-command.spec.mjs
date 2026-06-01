#!/usr/bin/env node
/**
 * Goal command adapter regression test.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/goal-command.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  executeGoalCommand,
  formatGoalCommandResult,
  handleGoalCommand,
  isGoalCommand,
  parseGoalCommand,
} from '../dist/goal.js';
import { DmossAgent, InMemorySessionStore } from '../dist/core/index.js';

function createProvider() {
  const requests = [];
  return {
    requests,
    provider: {
      id: 'goal-command-provider',
      displayName: 'Goal Command Provider',
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
          content: [{ type: 'text', text: 'ok' }],
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

function assertStructuredResult(result, { handled, action, goal = false, error = false }) {
  assert.equal(typeof result, 'object');
  assert.equal(result.handled, handled);
  assert.equal(typeof result.message, 'string');
  if (action !== undefined) assert.equal(result.action, action);
  if (goal) {
    assert.equal(typeof result.goal?.objective, 'string');
    assert.equal(typeof result.goal?.status, 'string');
  } else {
    assert.equal(result.goal, undefined);
  }
  if (error) {
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  } else {
    assert.equal(result.error, undefined);
  }
}

assert.equal(isGoalCommand('/goal'), true);
assert.equal(isGoalCommand('  /goal set stabilize command routing'), true);
assert.equal(isGoalCommand('/goals'), false);
assert.equal(isGoalCommand('please /goal status'), false);

assert.deepEqual(parseGoalCommand('hello'), { handled: false });
assert.deepEqual(parseGoalCommand('/goal'), { handled: true, action: 'status' });
assert.deepEqual(parseGoalCommand('/goal status'), { handled: true, action: 'status' });
assert.deepEqual(parseGoalCommand('/goal set ship host integration'), {
  handled: true,
  action: 'set',
  objective: 'ship host integration',
});
assert.deepEqual(parseGoalCommand('/goal pause waiting for review'), {
  handled: true,
  action: 'pause',
  reason: 'waiting for review',
});
assert.deepEqual(parseGoalCommand('/goal resume'), { handled: true, action: 'resume' });
assert.deepEqual(parseGoalCommand('/goal complete verified'), {
  handled: true,
  action: 'complete',
  reason: 'verified',
});
assert.deepEqual(parseGoalCommand('/goal block missing fixture'), {
  handled: true,
  action: 'block',
  reason: 'missing fixture',
});
assert.deepEqual(parseGoalCommand('/goal clear'), { handled: true, action: 'clear' });
assert.deepEqual(parseGoalCommand('/goal set    '), {
  handled: true,
  action: 'set',
  error: 'Goal objective must not be empty.',
});
assert.deepEqual(parseGoalCommand('/goal wat'), {
  handled: true,
  error: 'Unknown goal command: wat',
});

const sessionKey = 'goal-command-session';
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

const passthrough = await handleGoalCommand({ agent, sessionKey, input: 'normal chat' });
assertStructuredResult(passthrough, { handled: false });
assert.equal(passthrough.handled, false);
assert.equal(passthrough.message, '');

const emptySet = await handleGoalCommand({ agent, sessionKey, input: '/goal set' });
assertStructuredResult(emptySet, { handled: true, action: 'set', error: true });
assert.equal(emptySet.handled, true);
assert.equal(emptySet.action, 'set');
assert.match(emptySet.error, /objective/i);

const emptyStatus = await handleGoalCommand({ agent, sessionKey, input: '/goal' });
assertStructuredResult(emptyStatus, { handled: true, action: 'status' });
assert.equal(emptyStatus.handled, true);
assert.equal(emptyStatus.action, 'status');
assert.equal(emptyStatus.event, 'goal_status');
assert.equal(emptyStatus.goal, undefined);
assert.match(emptyStatus.message, /No goal/i);

const firstSet = await handleGoalCommand({
  agent,
  sessionKey,
  input: '/goal set stabilize command routing',
});
assertStructuredResult(firstSet, { handled: true, action: 'set', goal: true });
assert.equal(firstSet.handled, true);
assert.equal(firstSet.action, 'set');
assert.equal(firstSet.event, 'goal_set');
assert.equal(firstSet.goal?.objective, 'stabilize command routing');
assert.equal(firstSet.goal?.status, 'active');
assert.match(firstSet.message, /Goal set/);

const storedAfterSet = await store.loadMessages(sessionKey);
assert.equal(
  JSON.stringify(storedAfterSet).includes('dmoss_goal_checkpoint'),
  true,
  'goal checkpoint should remain internal to session storage',
);

const secondSet = await handleGoalCommand({
  agent,
  sessionKey,
  input: '/goal set finish host adapter',
});
assertStructuredResult(secondSet, { handled: true, action: 'set', goal: true });
assert.equal(secondSet.goal?.objective, 'finish host adapter');
assert.equal(secondSet.replaced, true);
assert.match(secondSet.message, /Goal replaced/);
assert.match(formatGoalCommandResult(secondSet), /Goal replaced/);

const status = await handleGoalCommand({ agent, sessionKey, input: '/goal status' });
assertStructuredResult(status, { handled: true, action: 'status', goal: true });
assert.equal(status.action, 'status');
assert.equal(status.goal?.objective, 'finish host adapter');
assert.match(status.message, /Current goal/);

const paused = await handleGoalCommand({
  agent,
  sessionKey,
  input: '/goal pause waiting for review',
});
assertStructuredResult(paused, { handled: true, action: 'pause', goal: true });
assert.equal(paused.action, 'pause');
assert.equal(paused.event, 'goal_paused');
assert.equal(paused.goal?.status, 'paused');
assert.equal(paused.goal?.statusReason, 'waiting for review');

const resumed = await handleGoalCommand({ agent, sessionKey, input: '/goal resume' });
assertStructuredResult(resumed, { handled: true, action: 'resume', goal: true });
assert.equal(resumed.action, 'resume');
assert.equal(resumed.event, 'goal_resumed');
assert.equal(resumed.goal?.status, 'active');
assert.equal(resumed.goal?.statusReason, undefined);

const completed = await handleGoalCommand({
  agent,
  sessionKey,
  input: '/goal complete verified',
});
assertStructuredResult(completed, { handled: true, action: 'complete', goal: true });
assert.equal(completed.action, 'complete');
assert.equal(completed.event, 'goal_completed');
assert.equal(completed.goal?.status, 'completed');
assert.equal(completed.goal?.statusReason, 'verified');

const completedStatus = await handleGoalCommand({ agent, sessionKey, input: '/goal status' });
assertStructuredResult(completedStatus, { handled: true, action: 'status', goal: true });
assert.equal(completedStatus.goal?.status, 'completed');
assert.match(completedStatus.message, /completed/);

const storedWithCompletedGoal = await store.loadMessages(sessionKey);
assert.match(
  JSON.stringify(storedWithCompletedGoal),
  /dmoss_goal_checkpoint/,
  'goal state should be persisted as an internal session checkpoint',
);
await collect(agent.streamChat(sessionKey, 'fresh request after complete'));
assert.equal(requests.length, 1);
assert.doesNotMatch(requests[0].systemPrompt, /<dmoss_goal_mode>/);
assert.equal(
  JSON.stringify(requests[0].messages).includes('dmoss_goal_checkpoint'),
  false,
  'goal checkpoint must not be sent as ordinary model-visible history',
);

await handleGoalCommand({ agent, sessionKey, input: '/goal set unblock adapter wiring' });
const blocked = await handleGoalCommand({
  agent,
  sessionKey,
  input: '/goal block waiting on host contract',
});
assertStructuredResult(blocked, { handled: true, action: 'block', goal: true });
assert.equal(blocked.action, 'block');
assert.equal(blocked.event, 'goal_blocked');
assert.equal(blocked.goal?.status, 'blocked');
assert.equal(blocked.goal?.statusReason, 'waiting on host contract');

const blockedStatus = await handleGoalCommand({ agent, sessionKey, input: '/goal status' });
assertStructuredResult(blockedStatus, { handled: true, action: 'status', goal: true });
assert.equal(blockedStatus.goal?.status, 'blocked');
assert.match(blockedStatus.message, /blocked/);
assert.match(blockedStatus.message, /waiting on host contract/);

const direct = await executeGoalCommand(
  agent,
  sessionKey,
  parseGoalCommand('/goal status'),
  { locale: 'zh-CN' },
);
assertStructuredResult(direct, { handled: true, action: 'status', goal: true });
assert.equal(direct.handled, true);
assert.equal(direct.action, 'status');
assert.equal(direct.goal?.status, 'blocked');
assert.match(direct.message, /当前目标/);

const cleared = await handleGoalCommand({ agent, sessionKey, input: '/goal clear' });
assertStructuredResult(cleared, { handled: true, action: 'clear' });
assert.equal(cleared.action, 'clear');
assert.equal(cleared.event, 'goal_cleared');
assert.equal(cleared.goal, undefined);
assert.match(cleared.message, /cleared/i);
assert.equal(await agent.getGoal(sessionKey), undefined);

const afterClear = await handleGoalCommand({ agent, sessionKey, input: '/goal status' });
assertStructuredResult(afterClear, { handled: true, action: 'status' });
assert.equal(afterClear.action, 'status');
assert.equal(afterClear.goal, undefined);
assert.match(afterClear.message, /No goal/i);

const pauseWithoutGoal = await handleGoalCommand({ agent, sessionKey, input: '/goal pause' });
assertStructuredResult(pauseWithoutGoal, { handled: true, action: 'pause', error: true });
assert.equal(pauseWithoutGoal.action, 'pause');
assert.match(pauseWithoutGoal.error, /No goal/);

console.log('goal-command tests passed');
