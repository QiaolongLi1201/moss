#!/usr/bin/env node
/**
 * Test for aborted status reset on continuation.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/task-frame-aborted-continuation.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  createOrUpdateTaskFrame,
} from '../dist/core/index.js';

// When user continues an aborted task, status should reset to 'active'
{
  const abortedFrame = {
    schemaVersion: 1,
    sessionKey: 's',
    goal: 'deploy service',
    constraints: [],
    currentStep: 'Tool execution was aborted by user',
    completedSteps: ['Started deployment'],
    pendingSteps: [],
    artifacts: [],
    importantPaths: [],
    toolFindings: [],
    lastError: 'Tool exec was aborted by user.',
    nextAction: 'Resume from before exec if the user asks to continue.',
    status: 'aborted',
    source: 'abort',
    updatedAt: Date.now(),
  };
  
  const resumed = createOrUpdateTaskFrame({
    previous: abortedFrame,
    sessionKey: 's',
    runId: 'r2',
    userMessage: '继续',
  });
  
  assert.equal(
    resumed.status,
    'active',
    'aborted status must reset to active on continuation intent'
  );
  assert.equal(
    resumed.source,
    'user',
    'source should be user when continuing'
  );
}

console.log('task-frame aborted continuation test passed');
