#!/usr/bin/env node
/**
 * Test that recordTaskFrameCompaction does not mutate input frame.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/task-frame-compaction-immutability.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  recordTaskFrameCompaction,
} from '../dist/core/index.js';

const originalFrame = {
  schemaVersion: 1,
  sessionKey: 's',
  goal: 'test goal',
  constraints: [],
  currentStep: 'testing',
  completedSteps: ['Step 1', 'Step 2'],
  pendingSteps: [],
  artifacts: [],
  importantPaths: [],
  toolFindings: [],
  nextAction: 'continue',
  status: 'active',
  source: 'user',
  updatedAt: Date.now(),
};

const completedStepsSnapshot = [...originalFrame.completedSteps];

const compacted = recordTaskFrameCompaction(originalFrame, {
  summaryChars: 5000,
  droppedMessages: 3,
});

assert.deepEqual(
  originalFrame.completedSteps,
  completedStepsSnapshot,
  'original frame completedSteps should not be mutated'
);

assert.notDeepEqual(
  originalFrame.completedSteps,
  compacted.completedSteps,
  'returned frame should have different completedSteps array'
);

assert.ok(
  compacted.completedSteps.length > originalFrame.completedSteps.length,
  'returned frame should have additional compaction step'
);

console.log('task-frame compaction immutability test passed');
