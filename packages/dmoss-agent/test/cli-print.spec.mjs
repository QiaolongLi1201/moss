#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-print.spec.mjs
 *
 * Asserts the headless stream-json output matches agent UI event schema:
 *   - tool_use is a content block inside an `assistant` message (no bare event)
 *   - tool_result is carried inside a `user` message
 *   - result uses subtype success|error_max_turns|error_during_execution and
 *     includes duration_ms / total_cost_usd / num_turns / session_id
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

// ── tool_use lives inside an assistant message; tool_result inside a user message ──
{
  const state = createHeadlessPrintState({ sessionId: 'cli-session', model: 'fake-model' });
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'turn_start', turn: 1 }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'text_delta', delta: 'Hello' }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, { type: 'text_delta', delta: ' world' }), []);

  // tool_start must NOT emit a bare tool_use event — it buffers a content block.
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    input: { path: 'README.md' },
  }), []);

  // tool_end flushes the assistant message (text + tool_use blocks) then the user tool_result.
  const afterToolEnd = formatHeadlessStreamEvent(state, {
    type: 'tool_end',
    toolName: 'read_file',
    toolCallId: 'tool-1',
    result: 'contents',
    isError: false,
  });
  assert.equal(afterToolEnd.length, 2);

  const assistantEvent = afterToolEnd[0];
  assert.equal(assistantEvent.type, 'assistant');
  assert.equal(assistantEvent.session_id, 'cli-session');
  assert.equal(assistantEvent.message.type, 'message');
  assert.equal(assistantEvent.message.role, 'assistant');
  assert.equal(assistantEvent.message.model, 'fake-model');
  assert.equal(assistantEvent.message.stop_reason, null);
  assert.ok(typeof assistantEvent.message.id === 'string' && assistantEvent.message.id.length > 0);
  // content carries the text block AND the tool_use block, no bare top-level tool_use.
  assert.deepEqual(assistantEvent.message.content, [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
  ]);

  const userEvent = afterToolEnd[1];
  assert.equal(userEvent.type, 'user');
  assert.equal(userEvent.session_id, 'cli-session');
  assert.equal(userEvent.message.role, 'user');
  assert.deepEqual(userEvent.message.content, [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' },
  ]);

  const doneEvents = formatHeadlessStreamEvent(state, {
    type: 'done',
    result: {
      response: 'Hello world',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 2, outputTokens: 3 },
      stopReason: 'end_turn',
    },
  });
  const resultEvent = doneEvents.at(-1);
  assert.equal(resultEvent.type, 'result');
  assert.equal(resultEvent.subtype, 'success');
  assert.equal(resultEvent.is_error, false);
  assert.equal(resultEvent.result, 'Hello world');
  assert.equal(resultEvent.num_turns, 1);
  assert.equal(resultEvent.session_id, 'cli-session');
  assert.equal(resultEvent.total_cost_usd, 0);
  assert.equal(typeof resultEvent.duration_ms, 'number');
  assert.ok(resultEvent.duration_ms >= 0);
  assert.deepEqual(resultEvent.usage, { inputTokens: 2, outputTokens: 3 });
}

// ── Parallel tool_use: two tool_start before tool_end → one assistant msg, two user events ──
{
  const state = createHeadlessPrintState({ sessionId: 'parallel', model: 'fake-model' });
  formatHeadlessStreamEvent(state, { type: 'turn_start', turn: 1 });
  formatHeadlessStreamEvent(state, { type: 'text_delta', delta: 'doing two' });
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'tool_start', toolName: 'read_file', toolCallId: 'a', input: { path: 'a' },
  }), []);
  assert.deepEqual(formatHeadlessStreamEvent(state, {
    type: 'tool_start', toolName: 'exec', toolCallId: 'b', input: { cmd: 'ls' },
  }), []);

  const firstEnd = formatHeadlessStreamEvent(state, {
    type: 'tool_end', toolName: 'read_file', toolCallId: 'a', result: 'ra', isError: false,
  });
  // First tool_end flushes ONE assistant message carrying both tool_use blocks, then user 'a'.
  assert.equal(firstEnd.length, 2);
  assert.equal(firstEnd[0].type, 'assistant');
  assert.deepEqual(firstEnd[0].message.content, [
    { type: 'text', text: 'doing two' },
    { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } },
    { type: 'tool_use', id: 'b', name: 'exec', input: { cmd: 'ls' } },
  ]);
  assert.equal(firstEnd[1].type, 'user');
  assert.equal(firstEnd[1].message.content[0].tool_use_id, 'a');

  const secondEnd = formatHeadlessStreamEvent(state, {
    type: 'tool_end', toolName: 'exec', toolCallId: 'b', result: 'rb', isError: true,
  });
  // Second tool_end has nothing left to flush → only the user tool_result event.
  assert.equal(secondEnd.length, 1);
  assert.equal(secondEnd[0].type, 'user');
  assert.deepEqual(secondEnd[0].message.content, [
    { type: 'tool_result', tool_use_id: 'b', content: 'rb', is_error: true },
  ]);
}

// ── max-turns maps to error_max_turns ──
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
  const result = events.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'error_max_turns');
  assert.equal(result.is_error, true);
  assert.equal(result.num_turns, 1);
  assert.equal(result.total_cost_usd, 0);
  assert.equal(typeof result.duration_ms, 'number');
}

// ── thrown error maps to error_during_execution ──
{
  const state = createHeadlessPrintState({ sessionId: 'thrown' });
  const events = formatHeadlessThrownError(state, new Error('boom'));
  assert.equal(events.length, 1);
  const result = events[0];
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.is_error, true);
  assert.equal(result.result, '');
  assert.equal(result.num_turns, 0);
  assert.equal(result.session_id, 'thrown');
  assert.equal(result.total_cost_usd, 0);
  assert.equal(typeof result.duration_ms, 'number');
  assert.equal(result.error, 'boom');
}

// ── stream-json end-to-end: ordering + no bare tool events + error subtype ──
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
  assert.equal(lines.at(-1).subtype, 'error_during_execution');
  assert.equal(lines.at(-1).error, 'boom');
  // No bare tool_use / tool_result events leak at the top level.
  for (const line of lines) {
    assert.notEqual(line.type, 'tool_use');
    assert.notEqual(line.type, 'tool_result');
  }
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

// ── full stream-json conversation: tool_use in assistant, tool_result in user, ordering ──
{
  const stdout = createCapture();
  const agent = makeFakeAgent([
    { type: 'turn_start', turn: 1 },
    { type: 'text_delta', delta: 'let me read' },
    { type: 'tool_start', toolName: 'read_file', toolCallId: 't1', input: { path: 'x' } },
    { type: 'tool_end', toolName: 'read_file', toolCallId: 't1', result: 'file body', isError: false },
    { type: 'text_delta', delta: 'all done' },
    { type: 'turn_end', turn: 1, stopReason: 'end_turn' },
    {
      type: 'done',
      result: {
        response: 'all done',
        toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'x' } }],
        toolResults: [{ toolUseId: 't1', content: 'file body' }],
        usage: { inputTokens: 5, outputTokens: 7 },
        stopReason: 'end_turn',
      },
    },
  ]);
  await runOneShot(agent, 'read x', undefined, {
    sessionKey: 'convo',
    outputFormat: 'stream-json',
    stdout: stdout.writer,
    cwd: '/tmp/work',
  });
  const lines = stdout.read().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].type, 'system');

  const assistantWithTool = lines.find(
    (l) => l.type === 'assistant' && l.message.content.some((b) => b.type === 'tool_use'),
  );
  assert.ok(assistantWithTool, 'expected an assistant message carrying a tool_use block');
  const toolUseIdx = lines.indexOf(assistantWithTool);

  const userWithResult = lines.find(
    (l) => l.type === 'user' && l.message.content.some((b) => b.type === 'tool_result'),
  );
  assert.ok(userWithResult, 'expected a user message carrying a tool_result block');
  const toolResultIdx = lines.indexOf(userWithResult);

  // assistant (with tool_use) MUST precede the matching user (tool_result).
  assert.ok(toolUseIdx < toolResultIdx, 'assistant tool_use must come before user tool_result');
  assert.equal(userWithResult.message.content[0].tool_use_id, 't1');

  const resultLine = lines.at(-1);
  assert.equal(resultLine.type, 'result');
  assert.equal(resultLine.subtype, 'success');
  assert.equal(resultLine.is_error, false);
  assert.equal(resultLine.result, 'all done');
  assert.equal(resultLine.total_cost_usd, 0);
  assert.equal(typeof resultLine.duration_ms, 'number');
  assert.deepEqual(resultLine.usage, { inputTokens: 5, outputTokens: 7 });

  // No bare tool_use / tool_result events anywhere.
  for (const line of lines) {
    assert.notEqual(line.type, 'tool_use');
    assert.notEqual(line.type, 'tool_result');
  }
}

// ── non-stream `json` aggregate behavior preserved (only the result object is written) ──
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
  assert.equal(result.subtype, 'error_max_turns');
  assert.equal(result.is_error, true);
  assert.equal(result.num_turns, 1);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

console.log('[PASS] CLI print formatter emits headless agent stream-json schema');
