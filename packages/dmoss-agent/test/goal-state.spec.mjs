#!/usr/bin/env node
/**
 * Goal mode core helpers regression test.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/goal-state.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  buildGoalModeContext,
  createGoalCheckpointMessage,
  createGoalState,
  isGoalCheckpointMessage,
  splitGoalCheckpointMessages,
  stripGoalCheckpointsFromLlmMessages,
  updateGoalState,
} from '../dist/core/index.js';

const now = 1_735_000_000_000;
const sessionKey = 'goal:thread:alpha';

const goal = createGoalState({
  sessionKey,
  objective: '  完成设备诊断并整理结论  ',
  now,
});

assert.equal(goal.sessionKey, sessionKey);
assert.equal(goal.objective, '完成设备诊断并整理结论');
assert.equal(goal.status, 'active');
assert.equal(goal.createdAt, now);
assert.equal(goal.updatedAt, now);

assert.throws(() => createGoalState({ sessionKey, objective: '   ' }), /objective/i);
assert.throws(
  () => createGoalState({ sessionKey, objective: 'x'.repeat(1001) }),
  /objective/i,
);

const paused = updateGoalState(goal, { status: 'paused', statusReason: 'waiting for user', now: now + 10 });
assert.equal(paused.status, 'paused');
assert.equal(paused.statusReason, 'waiting for user');
assert.equal(paused.pausedAt, now + 10);
assert.equal(paused.updatedAt, now + 10);

const resumed = updateGoalState(paused, { status: 'active', now: now + 20 });
assert.equal(resumed.status, 'active');
assert.equal(resumed.statusReason, undefined);
assert.equal(resumed.pausedAt, undefined);
assert.equal(resumed.updatedAt, now + 20);

const completed = updateGoalState(resumed, { status: 'completed', statusReason: 'done', now: now + 30 });
assert.equal(completed.status, 'completed');
assert.equal(completed.statusReason, 'done');
assert.equal(completed.completedAt, now + 30);

const blocked = updateGoalState(resumed, { status: 'blocked', statusReason: 'needs approval', now: now + 40 });
assert.equal(blocked.status, 'blocked');
assert.equal(blocked.statusReason, 'needs approval');
assert.equal(blocked.blockedAt, now + 40);

const checkpoint = createGoalCheckpointMessage(goal);
assert.equal(isGoalCheckpointMessage(checkpoint), true);

const sessionMessages = [
  { role: 'user', content: 'hello', timestamp: now },
  checkpoint,
  { role: 'assistant', content: 'world', timestamp: now + 1 },
];

const split = splitGoalCheckpointMessages(sessionMessages);
assert.equal(split.goal?.objective, goal.objective);
assert.deepEqual(split.messages, [
  { role: 'user', content: 'hello', timestamp: now },
  { role: 'assistant', content: 'world', timestamp: now + 1 },
]);

const stripped = stripGoalCheckpointsFromLlmMessages(sessionMessages);
assert.deepEqual(stripped, [
  { role: 'user', content: 'hello', timestamp: now },
  { role: 'assistant', content: 'world', timestamp: now + 1 },
]);

assert.match(buildGoalModeContext(goal), /完成设备诊断并整理结论/);
assert.match(buildGoalModeContext(paused), /waiting for user/);
assert.equal(buildGoalModeContext(completed), '');
assert.equal(buildGoalModeContext(blocked), '');

console.log('goal-state tests passed');
