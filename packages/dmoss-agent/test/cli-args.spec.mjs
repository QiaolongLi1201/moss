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
    'profile=autonomous',
    '-c',
    'model=deepseek-v4-pro',
    '-c',
    'safetyMode=read-only',
    '-c',
    'approvalPolicy=never',
    '-c',
    'trustedTools=exec,filesystem__*',
    '-c',
    'deniedTools=device_*',
    '-c',
    'promptCache=false',
    '-c',
    'promptCacheDebug=true',
    '-c',
    'maxTurns=17',
    '-c',
    'contextTokens=96000',
    '--',
    'run diff -r',
  ]);
  assert.equal(parsed.configOverrides.provider, 'openai-compatible');
  assert.equal(parsed.configOverrides.baseUrl, 'https://api.deepseek.com');
  assert.equal(parsed.configOverrides.profile, 'autonomous');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.configOverrides.safetyMode, 'read-only');
  assert.equal(parsed.configOverrides.approvalPolicy, 'never');
  assert.deepEqual(parsed.configOverrides.trustedTools, ['exec', 'filesystem__*']);
  assert.deepEqual(parsed.configOverrides.deniedTools, ['device_*']);
  assert.equal(parsed.configOverrides.promptCacheEnabled, false);
  assert.equal(parsed.configOverrides.promptCacheDebug, true);
  assert.equal(parsed.configOverrides.maxAgentTurns, 17);
  assert.equal(parsed.configOverrides.contextTokens, 96000);
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
  const parsed = parseCliArgs(['--help', '--all']);
  assert.equal(parsed.help, true);
  assert.equal(parsed.helpAll, true);
  assert.equal(parsed.command, 'chat');
}

{
  const parsed = parseCliArgs(['config']);
  assert.equal(parsed.command, 'config');
  assert.deepEqual(parsed.commandArgs, []);
  assert.equal(parsed.prompt, '');
}

{
  const parsed = parseCliArgs(['config', 'show']);
  assert.equal(parsed.command, 'config');
  assert.deepEqual(parsed.commandArgs, ['show']);
  assert.equal(parsed.prompt, '');
}

{
  const parsed = parseCliArgs(['--model', 'deepseek-v4-pro', 'doctor']);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.prompt, '');
}

{
  const parsed = parseCliArgs(['--config-file', '/tmp/dmoss-custom.json', 'config', 'show']);
  assert.equal(parsed.command, 'config');
  assert.deepEqual(parsed.commandArgs, ['show']);
  assert.equal(parsed.prompt, '');
}

{
  const parsed = parseCliArgs(['-p', '--output-format', 'stream-json', '--max-turns', '3', 'hello']);
  assert.equal(parsed.print, true);
  assert.equal(parsed.outputFormat, 'stream-json');
  assert.equal(parsed.maxTurns, 3);
  assert.equal(parsed.configOverrides.maxAgentTurns, 3);
  assert.equal(parsed.prompt, 'hello');
}

assert.throws(() => parseCliArgs(['-c', 'temperature=0.7']), /Unsupported --config key/);
assert.throws(() => parseCliArgs(['-c', 'profile=reckless']), /Unsupported profile/);
assert.throws(() => parseCliArgs(['-c', 'trustedTools=!write_*']), /Unsupported trusted tool name/);
assert.throws(() => parseCliArgs(['-c', 'maxTurns=0']), /Unsupported maxAgentTurns/);
assert.throws(() => parseCliArgs(['-c', 'contextTokens=1.5']), /Unsupported contextTokens/);
assert.throws(() => parseCliArgs(['--max-turns', '0', 'hello']), /--max-turns/);

console.log('[PASS] CLI argument parser preserves prompts and override flags');
