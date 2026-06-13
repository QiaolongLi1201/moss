#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-args.spec.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { parseCliArgs } from '../dist/cli/args.js';

{
  const workspaceArg = path.join(os.tmpdir(), 'dmoss-cli-args-workspace');
  const parsed = parseCliArgs(['-m', 'deepseek-v4-pro', '-C', workspaceArg, 'hello', 'world']);
  assert.equal(parsed.command, 'chat');
  assert.equal(parsed.configOverrides.model, 'deepseek-v4-pro');
  assert.equal(parsed.configOverrides.workspace, path.resolve(workspaceArg));
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
    'imageInput=true',
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
  assert.equal(parsed.configOverrides.imageInput, true);
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

// --ask-for-approval must reject unknown values instead of silently ignoring
// them (a typo like `--ask-for-approval yolo` used to look accepted while
// changing nothing).
assert.throws(() => parseCliArgs(['--ask-for-approval', 'yolo', 'hi']), /--ask-for-approval must be/);
assert.throws(() => parseCliArgs(['--ask-for-approval=bogus', 'hi']), /--ask-for-approval must be/);
{
  // Every documented value is still accepted with its existing effect.
  assert.equal(parseCliArgs(['--ask-for-approval', 'never', 'hi']).approvalPolicy, 'never');
  assert.equal(parseCliArgs(['--ask-for-approval', 'never', 'hi']).configOverrides.approvalPolicy, 'never');
  const prompt = parseCliArgs(['--ask-for-approval', 'prompt', 'hi']);
  assert.equal(prompt.approvalPolicy, 'prompt');
  assert.equal(prompt.safetyModeOverride, undefined);
  const onRequest = parseCliArgs(['--ask-for-approval', 'on-request', 'hi']);
  assert.equal(onRequest.approvalPolicy, 'prompt');
  assert.equal(onRequest.safetyModeOverride, 'workspace-write');
  assert.equal(parseCliArgs(['--ask-for-approval', 'full-access', 'hi']).safetyModeOverride, 'full-access');
  assert.equal(parseCliArgs(['--ask-for-approval', 'read-only', 'hi']).safetyModeOverride, 'read-only');
}

// Mistyped subcommands must be caught before they become billable chat one-shots.
import { closestKnownCommand } from '../dist/cli/args.js';
{
  // Typos close to a real command are flagged with a suggestion, NOT run as chat.
  for (const [typo, expected] of [
    ['confgi', 'config'],
    ['resme', 'resume'],
    ['setpu', 'setup'],
    ['doctr', 'doctor'],
    ['mcpp', 'mcp'],
  ]) {
    const parsed = parseCliArgs([typo]);
    assert.equal(parsed.command, 'chat', `${typo} still parses as chat command`);
    assert.ok(parsed.unknownCommand, `${typo} should be flagged as an unknown command`);
    assert.equal(parsed.unknownCommand.token, typo);
    assert.equal(parsed.unknownCommand.suggestion, expected, `${typo} -> ${expected}`);
  }
}
{
  // Legitimate one-word prompts are far from every command and must reach chat.
  for (const word of ['hi', 'help me', 'ls', 'why', 'go']) {
    const parsed = parseCliArgs(word.split(' '));
    assert.equal(parsed.unknownCommand, undefined, `'${word}' must NOT be treated as a typo'd command`);
    assert.equal(parsed.prompt, word);
  }
}
{
  // Multi-word prose and flag-bearing invocations are never intercepted.
  assert.equal(parseCliArgs(['tell', 'me', 'about', 'confgi']).unknownCommand, undefined);
  assert.equal(parseCliArgs(['-m', 'x', 'confgi']).unknownCommand, undefined);
  assert.equal(parseCliArgs(['--', 'confgi']).unknownCommand, undefined);
  // Real commands never trip the typo guard.
  assert.equal(parseCliArgs(['config']).unknownCommand, undefined);
  assert.equal(parseCliArgs(['doctor']).unknownCommand, undefined);
}
{
  // closestKnownCommand: conservative edit-distance-2 matcher.
  assert.equal(closestKnownCommand('confgi'), 'config');
  assert.equal(closestKnownCommand('config'), null, 'exact command is not a typo');
  assert.equal(closestKnownCommand('hi'), null, 'far from every command');
  assert.equal(closestKnownCommand(''), null);
}

console.log('[PASS] CLI argument parser preserves prompts and override flags');
