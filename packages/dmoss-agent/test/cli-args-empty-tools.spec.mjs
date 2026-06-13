#!/usr/bin/env node
/**
 * Test: trustedTools and deniedTools reject empty values
 * Run: npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/cli-args-empty-tools.spec.mjs
 */
import assert from 'node:assert/strict';
import { parseCliArgs } from '../dist/cli/args.js';

// Test 1: -c trustedTools= should throw
{
  try {
    parseCliArgs(['-c', 'trustedTools=']);
    assert.fail('Expected error for empty trustedTools=');
  } catch (err) {
    assert(err.message.includes('empty value not allowed'));
  }
}

// Test 2: -c deniedTools= should throw
{
  try {
    parseCliArgs(['-c', 'deniedTools=']);
    assert.fail('Expected error for empty deniedTools=');
  } catch (err) {
    assert(err.message.includes('empty value not allowed'));
  }
}

// Test 3: Non-empty values should still work
{
  const parsed = parseCliArgs(['-c', 'trustedTools=exec,filesystem__*']);
  assert.deepEqual(parsed.configOverrides.trustedTools, ['exec', 'filesystem__*']);
}

console.log('✓ All empty tools validation tests passed');
