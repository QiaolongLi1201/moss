import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeToResult } from '../dist/core/tools/execute-tool-call.js';

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
