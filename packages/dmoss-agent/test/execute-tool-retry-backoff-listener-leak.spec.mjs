import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';

describe('execute-tool retry backoff listener hygiene', () => {
  it('does not leak abort listeners on the run signal across retries', async () => {
    const runAbort = new AbortController();
    let attempt = 0;
    const tool = {
      name: 'always_transient_probe',
      description: 'always fails transiently to exercise both retry backoffs',
      metadata: { transientRetry: true },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        attempt++;
        throw new Error('connection reset by peer');
      },
    };

    const outcome = await executeOneToolCall(
      { id: 'call-leak', name: 'always_transient_probe', input: {} },
      {
        toolsForRun: [tool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 's' },
        sessionKey: 's',
        abortSignal: runAbort.signal,
        toolTimeoutMs: 2_000,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push: () => {},
      },
    );

    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.isError, true);
    // Two backoff waits (500ms + 1500ms) ran and completed normally; neither
    // should leave an abort listener registered on the long-lived run signal.
    assert.ok(attempt >= 3, 'all retry attempts must have run');
    const listeners = getEventListeners(runAbort.signal, 'abort').length;
    assert.equal(
      listeners,
      0,
      `run signal must have no leaked abort listeners, found ${listeners}`,
    );
  });
});
