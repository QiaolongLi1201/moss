import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';

describe('execute-tool transient retry + structured content', () => {
  it('does not surface stale structuredContent when a retry attempt rejects', async () => {
    let attempt = 0;
    const tool = {
      name: 'flaky_structured_probe',
      description: 'structured tool that errors transiently then rejects',
      metadata: { transientRetry: true, sideEffectClass: 'readonly' },
      inputSchema: { type: 'object', properties: {} },
      async executeStructured() {
        attempt++;
        if (attempt === 1) {
          // First attempt: structured isError with a transient message -> eligible for retry
          return {
            content: [{ type: 'text', text: 'connection reset by peer' }],
            isError: true,
          };
        }
        // Retry attempt: reject (no structured content produced)
        throw new Error('connection reset by peer');
      },
    };

    const outcome = await executeOneToolCall(
      { id: 'call-flaky', name: 'flaky_structured_probe', input: {} },
      {
        toolsForRun: [tool],
        toolCtx: { workspaceDir: process.cwd(), sessionKey: 's' },
        sessionKey: 's',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 2_000,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push: () => {},
      },
    );

    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.isError, true);
    // The retry rejected and produced no structured content, so the result must
    // not carry the first attempt's blocks alongside the retry's error text.
    assert.equal(
      outcome.structuredContent,
      undefined,
      'stale structuredContent from a prior attempt must not be returned',
    );
    assert.ok(attempt >= 2, 'test must exercise the retry path');
  });
});
