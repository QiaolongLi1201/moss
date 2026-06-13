#!/usr/bin/env node
/**
 * Test: model, provider, baseUrl, workspace reject empty values via -c
 * Run: npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/cli-args-empty-config-keys.spec.mjs
 */
import assert from 'node:assert/strict';
import { parseCliArgs } from '../dist/cli/args.js';

const emptyConfigTests = [
  { flag: 'model=', key: 'model' },
  { flag: 'provider=', key: 'provider' },
  { flag: 'baseUrl=', key: 'baseUrl' },
  { flag: 'workspace=', key: 'workspace' },
];

for (const test of emptyConfigTests) {
  try {
    parseCliArgs(['-c', test.flag]);
    assert.fail(`Expected error for -c ${test.flag}`);
  } catch (err) {
    assert(
      err.message.includes('empty value not allowed'),
      `Wrong error for ${test.key}: ${err.message}`
    );
  }
}

// Test: non-empty values should still work
{
  const parsed = parseCliArgs(['-c', 'model=custom-model', '-c', 'provider=openai']);
  assert.equal(parsed.configOverrides.model, 'custom-model');
  assert.equal(parsed.configOverrides.provider, 'openai');
}

console.log('✓ All empty config key validation tests passed');
