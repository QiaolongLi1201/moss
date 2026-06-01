#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-output.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  createCliRunRenderer,
  resolveCliDetailMode,
  summarizeForCli,
} from '../dist/cli/output.js';

function createCapture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    read() {
      return text;
    },
  };
}

assert.equal(resolveCliDetailMode([], {}), 'progress');
assert.equal(resolveCliDetailMode(['--quiet'], {}), 'quiet');
assert.equal(resolveCliDetailMode(['--json'], {}), 'quiet');
assert.equal(resolveCliDetailMode([], { DMOSS_CLI_DETAIL: 'verbose' }), 'verbose');
assert.equal(resolveCliDetailMode(['--json'], { DMOSS_CLI_DETAIL: 'progress' }), 'progress');
assert.equal(resolveCliDetailMode([], { DMOSS_VERBOSE_CLI: 'true' }), 'verbose');

const summary = summarizeForCli({
  command: 'echo ok',
  password: 'secret',
  host: '192.168.1.2',
});
assert.match(summary, /\[REDACTED\]/);
assert.match(summary, /\[IP_REDACTED\]/);
assert.doesNotMatch(summary, /secret/);

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'progress',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({ type: 'turn_start', turn: 1 });
  renderer.handle({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    input: { command: 'hostname', password: 'secret' },
  });
  renderer.handle({
    type: 'tool_end',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    result: 'rdk-x5\n',
    isError: false,
  });
  renderer.handle({ type: 'text_delta', delta: 'Done' });
  renderer.handle({
    type: 'done',
    result: { response: 'Done', toolCalls: [], toolResults: [] },
  });

  assert.equal(stdout.read(), 'Done\n');
  assert.match(stderr.read(), /- thinking turn 1/);
  assert.match(stderr.read(), /- device_exec running/);
  assert.match(stderr.read(), /ok device_exec ok \d+ms/);
  assert.doesNotMatch(stderr.read(), /hostname/);
  assert.doesNotMatch(stderr.read(), /rdk-x5/);
  assert.doesNotMatch(stderr.read(), /secret/);
}

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'verbose',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({
    type: 'tool_start',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    input: { command: 'hostname', password: 'secret' },
  });
  renderer.handle({
    type: 'tool_end',
    toolName: 'device_exec',
    toolCallId: 'tool-1',
    result: 'rdk-x5\n',
    isError: false,
  });
  assert.match(stderr.read(), /hostname/);
  assert.match(stderr.read(), /rdk-x5/);
  assert.match(stderr.read(), /\[REDACTED\]/);
  assert.doesNotMatch(stderr.read(), /secret/);
}

{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({
    detailMode: 'quiet',
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  renderer.handle({ type: 'turn_start', turn: 1 });
  renderer.handle({
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    input: { path: 'README.md' },
  });
  renderer.handle({ type: 'text_delta', delta: 'Only answer' });
  renderer.handle({
    type: 'done',
    result: { response: 'Only answer', toolCalls: [], toolResults: [] },
  });
  assert.equal(stdout.read(), 'Only answer\n');
  assert.equal(stderr.read(), '');
}

console.log('[PASS] CLI output renderer shows safe beginner progress');
