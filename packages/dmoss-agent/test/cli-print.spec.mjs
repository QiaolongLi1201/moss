#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-print.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  createHeadlessPrintState,
  formatHeadlessInitEvent,
  formatHeadlessStreamEvent,
  formatHeadlessThrownError,
} from '../dist/cli/print.js';
import { runOneShot } from '../dist/cli/oneshot.js';

function createCapture() {
  let text = '';
  return {
    writer: {
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

function makeFakeAgent(events) {
  return {
    config: {
      model: 'fake-model',
      sessionStore: {
        async loadMessages() {
          return [];
        },
      },
    },
    tools: {
      getAll() {
        return [{ name: 'read_file' }, { name: 'exec' }];
      },
    },
    async *streamChat() {
      for (const event of events) {
        if (event instanceof Error) throw event;
        yield event;
      }
    },
  };
}

const init = formatHeadlessInitEvent({
  cwd: '/tmp/work',
  model: 'fake-model',
  tools: ['read_file', 'exec'],
  sessionId: 'cli-session',
});
assert.deepEqual(init, {
  type: 'system',
  subtype: 'init',
  cwd: '/tmp/work',
  model: 'fake-model',
  tools: ['read_file', 'exec'],
  session_id: 'cli-session',
});

{
  const state = createHeadlessPrintState({ sessionId: 'cli-session' });
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'turn_start', turn: 1 }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'text_delta', delta: 'Hello' }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'text_delta', delta: ' world' }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    input: { path: 'README.md' },
  }), [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
      session_id: 'cli-session',
    },
    {
      type: 'tool_use',
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'README.md' },
      session_id: 'cli-session',
    },
  ]);
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'tool_end',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    result: 'contents',
    isError: false,
  }), [
    {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      is_error: false,
      content: 'contents',
      session_id: 'cli-session',
    },
  ]);
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'done',
    result: {
      response: 'Hello world',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 2, outputTokens: 3 },
      stopReason: 'end_turn',
    },
  }), [
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Hello world',
      num_turns: 1,
      session_id: 'cli-session',
      usage: { inputTokens: 2, outputTokens: 3 },
    },
  ]);
}

{
  const state = createHeadlessPrintState({ sessionId: 'limited' });
  formatHeadlessStreamEvent(state, { type: 'turn_start', turn: 1 });
  const events = formatHeadlessStreamEvent(state, {
    type: 'done',
    result: {
      response: '',
      toolCalls: [],
      toolResults: [],
      stopReason: 'max_turns_reached',
    },
  });
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).subtype, 'error');
  assert.equal(events.at(-1).is_error, true);
  assert.equal(events.at(-1).num_turns, 1);
}

{
  const state = createHeadlessPrintState({ sessionId: 'thrown' });
  const events = formatHeadlessThrownError(state, new Error('boom'));
  assert.deepEqual(events, [{
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: '',
    num_turns: 0,
    session_id: 'thrown',
    error: 'boom',
  }]);
}

{
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const stdout = createCapture();
  const agent = makeFakeAgent([
    { type: 'turn_start', turn: 1 },
    { type: 'text_delta', delta: 'partial' },
    new Error('boom'),
  ]);
  await runOneShot(agent, 'hi', undefined, {
    sessionKey: 'stream-error',
    outputFormat: 'stream-json',
    stdout: stdout.writer,
    cwd: '/tmp/work',
  });
  const lines = stdout.read().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].type, 'system');
  assert.equal(lines.at(-2).type, 'assistant');
  assert.equal(lines.at(-1).type, 'result');
  assert.equal(lines.at(-1).is_error, true);
  assert.equal(lines.at(-1).error, 'boom');
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

{
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const stdout = createCapture();
  const agent = makeFakeAgent([
    { type: 'turn_start', turn: 1 },
    {
      type: 'done',
      result: {
        response: '',
        toolCalls: [],
        toolResults: [],
        stopReason: 'max_turns_reached',
      },
    },
  ]);
  await runOneShot(agent, 'hi', undefined, {
    sessionKey: 'max-turns',
    outputFormat: 'json',
    stdout: stdout.writer,
  });
  const result = JSON.parse(stdout.read());
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'error');
  assert.equal(result.is_error, true);
  assert.equal(result.num_turns, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

console.log('[PASS] CLI print formatter emits headless structured output');
