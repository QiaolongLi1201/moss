#!/usr/bin/env node
/**
 * Test that recordTaskFrameAssistant does not mutate input frame.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/task-frame-assistant-immutability.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  recordTaskFrameAssistant,
} from '../dist/core/index.js';

const originalFrame = {
  schemaVersion: 1,
  sessionKey: 's',
  goal: 'test goal',
  constraints: [],
  currentStep: 'awaiting response',
  completedSteps: ['Step 1'],
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

const withAssistantResponse = recordTaskFrameAssistant(
  originalFrame,
  'Here is my response to the task',
  'end_turn'
);

assert.deepEqual(
  originalFrame.completedSteps,
  completedStepsSnapshot,
  'original frame completedSteps should not be mutated'
);

assert.notDeepEqual(
  originalFrame.completedSteps,
  withAssistantResponse.completedSteps,
  'returned frame should have different completedSteps array'
);

assert.ok(
  withAssistantResponse.completedSteps.length > originalFrame.completedSteps.length,
  'returned frame should have additional assistant response step'
);

console.log('task-frame assistant immutability test passed');
