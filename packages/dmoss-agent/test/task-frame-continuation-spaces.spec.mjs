#!/usr/bin/env node
/**
 * Test for consistent space handling in continuation detection.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/task-frame-continuation-spaces.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  detectContinuationIntent,
} from '../dist/core/index.js';

// Test that extra spaces don't break English continuation detection
assert.deepEqual(
  detectContinuationIntent('please continue'),
  { isContinuation: true, isArchiveLookup: false },
  'should recognize "please continue"'
);

assert.deepEqual(
  detectContinuationIntent('please  continue'),
  { isContinuation: true, isArchiveLookup: false },
  'should recognize "please  continue" with extra space'
);

assert.deepEqual(
  detectContinuationIntent('continue'),
  { isContinuation: true, isArchiveLookup: false },
  'should recognize "continue"'
);

assert.deepEqual(
  detectContinuationIntent('go  on'),
  { isContinuation: true, isArchiveLookup: false },
  'should recognize "go  on" with extra space'
);

assert.deepEqual(
  detectContinuationIntent('请 继续'),
  { isContinuation: true, isArchiveLookup: false },
  'should recognize Chinese "请 继续" with space'
);

console.log('task-frame continuation spaces test passed');
