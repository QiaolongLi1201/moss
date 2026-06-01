#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-args.spec.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCliArgs } from '../dist/cli/args.js';

{
  const parsed = parseCliArgs(['-m', 'deepseek-v4-pro', '-C', '/tmp', 'hello', 'world']);
  assert.equal(parsed.command, 'chat');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.configOverrides.workspace, path.resolve('/tmp'));
  assert.equal(parsed.prompt, 'hello world');
}

{
  const parsed = parseCliArgs([
    '--provider=openai-compatible',
    '--base-url',
    'https://api.deepseek.com',
    '-c',
    'model=deepseek-v4-pro',
    '-c',
    'safetyMode=read-only',
    '-c',
    'approvalPolicy=never',
    '-c',
    'promptCache=false',
    '-c',
    'promptCacheDebug=true',
    '--',
    'run diff -r',
  ]);
  assert.equal(parsed.configOverrides.provider, 'openai-compatible');
  assert.equal(parsed.configOverrides.baseUrl, 'https://api.deepseek.com');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.configOverrides.safetyMode, 'read-only');
  assert.equal(parsed.configOverrides.approvalPolicy, 'never');
  assert.equal(parsed.configOverrides.promptCacheEnabled, false);
  assert.equal(parsed.configOverrides.promptCacheDebug, true);
  assert.equal(parsed.prompt, 'run diff -r');
}

{
  const parsed = parseCliArgs(['resume', '--last', '--session', 'cli']);
  assert.equal(parsed.command, 'resume');
  assert.equal(parsed.sessionLast, true);
  assert.equal(parsed.sessionKey, 'cli');
}

{
  const parsed = parseCliArgs(['fork', '--fork-from', 'cli', 'continue from here']);
  assert.equal(parsed.command, 'fork');
  assert.equal(parsed.forkSource, 'cli');
  assert.equal(parsed.prompt, 'continue from here');
}

{
  const parsed = parseCliArgs(['--ask-for-approval', 'never', '--full-access', 'ship it']);
  assert.equal(parsed.approvalPolicy, 'never');
  assert.equal(parsed.configOverrides.approvalPolicy, 'never');
  assert.equal(parsed.safetyModeOverride, 'full-access');
  assert.equal(parsed.prompt, 'ship it');
}

{
  const parsed = parseCliArgs(['doctor']);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.prompt, '');
}

{
  const parsed = parseCliArgs(['--model', 'deepseek-v4-pro', 'doctor']);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.prompt, '');
}

assert.throws(() => parseCliArgs(['-c', 'temperature=0.7']), /Unsupported --config key/);

console.log('[PASS] CLI argument parser preserves prompts and override flags');
