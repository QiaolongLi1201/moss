import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { executeOneToolCall, outcomeToResult } from '../dist/core/tools/execute-tool-call.js';

describe('Structured Tool Content Blocks', () => {
  it('outcomeToResult propagates structuredContent from completed outcome', () => {
    const outcome = {
      kind: 'completed',
      text: 'hello',
      isError: false,
      durationMs: 100,
      structuredContent: [{ type: 'text', text: 'hello' }],
    };
    const result = outcomeToResult(outcome);
    assert.equal(result.text, 'hello');
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, [{ type: 'text', text: 'hello' }]);
  });

  it('outcomeToResult omits structuredContent when not present', () => {
    const outcome = {
      kind: 'completed',
      text: 'hello',
      isError: false,
      durationMs: 100,
    };
    const result = outcomeToResult(outcome);
    assert.equal(result.structuredContent, undefined);
  });

  it('outcomeToResult propagates multi-block structuredContent', () => {
    const blocks = [
      { type: 'text', text: 'line 1' },
      { type: 'image', data: 'base64', mimeType: 'image/png' },
      { type: 'text', text: 'line 2' },
    ];
    const outcome = {
      kind: 'completed',
      text: 'line 1\nline 2',
      isError: false,
      durationMs: 50,
      structuredContent: blocks,
    };
    const result = outcomeToResult(outcome);
    assert.equal(result.structuredContent.length, 3);
    assert.equal(result.structuredContent[1].type, 'image');
  });

  it('outcomeToResult strips structuredContent from denied outcome', () => {
    const outcome = { kind: 'denied', text: 'not approved' };
    const result = outcomeToResult(outcome);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  });

  it('outcomeToResult strips structuredContent from hook-blocked outcome', () => {
    const outcome = { kind: 'hook-blocked', text: 'blocked by hook' };
    const result = outcomeToResult(outcome);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  });

  it('outcomeToResult preserves isError flag from completed outcome', () => {
    const outcome = {
      kind: 'completed',
      text: 'error occurred',
      isError: true,
      durationMs: 200,
      structuredContent: [{ type: 'text', text: 'error occurred' }],
    };
    const result = outcomeToResult(outcome);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, [{ type: 'text', text: 'error occurred' }]);
  });
});

describe('Tool Timeout Classification', () => {
  it('does not let heartbeat watchdog preempt a tool within timeoutMs', async () => {
    const events = [];
    const tool = {
      name: 'slow_but_valid_probe',
      description: 'Completes within its declared timeout',
      inputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        await delay(60, undefined, { signal: ctx.abortSignal });
        return 'completed inside timeout';
      },
    };

    const outcome = await executeOneToolCall(
      { id: 'call-slow-valid', name: 'slow_but_valid_probe', input: {} },
      {
        toolsForRun: [tool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 'slow-valid-session' },
        sessionKey: 'slow-valid-session',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 120,
        enableHeartbeat: true,
        heartbeatIntervalMs: 10,
        skipHeartbeatToolNames: new Set(),
        push: (event) => events.push(event),
      },
    );

    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.isError, false);
    assert.equal(outcome.text, 'completed inside timeout');
    assert.equal(outcome.aborted, undefined);
    assert.ok(
      events.filter((event) => event.type === 'tool_execution_progress').length >= 3,
      'test must exercise the heartbeat watchdog path before completion',
    );
  });

  it('classifies the internal watchdog timeout as timeout, not user abort', async () => {
    const events = [];
    const runAbort = new AbortController();
    const tool = {
      name: 'slow_probe',
      description: 'Never resolves',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return new Promise(() => {});
      },
    };

    const outcome = await executeOneToolCall(
      { id: 'call-timeout', name: 'slow_probe', input: {} },
      {
        toolsForRun: [tool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 'timeout-session' },
        sessionKey: 'timeout-session',
        abortSignal: runAbort.signal,
        toolTimeoutMs: 20,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push: (event) => events.push(event),
      },
    );

    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.isError, true);
    assert.deepEqual(outcome.aborted, { by: 'timeout' });
    assert.match(outcome.text, /timed out/i);
    assert.equal(events.filter((event) => event.type === 'tool_execution_start').length, 1);
  });
});

describe('Tool Approval Denial', () => {
  it('falls back to the generic denial message when the reason is blank', async () => {
    const outcome = await executeOneToolCall(
      { id: 'call-denied-blank', name: 'approval_probe', input: {} },
      {
        toolsForRun: [{
          name: 'approval_probe',
          description: 'Should not execute',
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            assert.fail('denied tool must not execute');
          },
        }],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 'denied-blank-session' },
        sessionKey: 'denied-blank-session',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 1_000,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        checkToolApproval: async () => ({ approved: false, decision: 'deny', reason: '   ' }),
        push: () => {},
      },
    );

    assert.deepEqual(outcome, {
      kind: 'denied',
      text: 'Tool execution denied by user.',
    });
  });
});

describe('Tool Abort Classification Snapshot', () => {
  it('keeps the public aborted.by domain stable', async () => {
    const events = [];
    const slowTool = {
      name: 'slow_probe',
      description: 'Never resolves',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return new Promise(() => {});
      },
    };

    const timeoutOutcome = await executeOneToolCall(
      { id: 'call-timeout-snapshot', name: 'slow_probe', input: {} },
      {
        toolsForRun: [slowTool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 'timeout-snapshot' },
        sessionKey: 'timeout-snapshot',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 20,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push: (event) => events.push(event),
      },
    );

    const abortController = new AbortController();
    setTimeout(() => abortController.abort('user cancelled'), 5);
    const userAbortOutcome = await executeOneToolCall(
      { id: 'call-user-abort-snapshot', name: 'slow_probe', input: {} },
      {
        toolsForRun: [slowTool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 'user-abort-snapshot' },
        sessionKey: 'user-abort-snapshot',
        abortSignal: abortController.signal,
        toolTimeoutMs: 1_000,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push: (event) => events.push(event),
      },
    );

    assert.deepEqual(
      [
        timeoutOutcome.kind === 'completed' ? timeoutOutcome.aborted?.by : undefined,
        userAbortOutcome.kind === 'completed' ? userAbortOutcome.aborted?.by : undefined,
      ],
      ['timeout', 'user'],
    );
  });
});
