import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeToResult } from '../dist/core/tools/execute-tool-call.js';

describe('Structured Tool Content Blocks', () => {
  it('ToolContentBlock text type serializes correctly', () => {
    const block = { type: 'text', text: 'hello world' };
    assert.equal(block.type, 'text');
    assert.equal(block.text, 'hello world');
  });

  it('ToolContentBlock image type has required fields', () => {
    const block = { type: 'image', data: 'base64data', mimeType: 'image/png', alt: 'screenshot' };
    assert.equal(block.type, 'image');
    assert.equal(block.mimeType, 'image/png');
  });

  it('ToolContentBlock resource type has required fields', () => {
    const block = { type: 'resource', uri: 'file:///tmp/out.log', name: 'build-log' };
    assert.equal(block.type, 'resource');
    assert.equal(block.uri, 'file:///tmp/out.log');
  });

  it('structured result text extraction works', () => {
    const content = [
      { type: 'text', text: 'line 1' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'text', text: 'line 2' },
    ];
    const text = content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    assert.equal(text, 'line 1\nline 2');
  });

  it('structured result with no text blocks produces fallback', () => {
    const content = [
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ];
    const textParts = content.filter(b => b.type === 'text').map(b => b.text);
    const text = textParts.length > 0 ? textParts.join('\n') : `[${content.length} content block(s): ${content.map(b => b.type).join(', ')}]`;
    assert.equal(text, '[1 content block(s): image]');
  });

  it('outcomeToResult propagates structuredContent from completed outcome', () => {
    const outcome = {
      kind: 'completed',
      text: 'hello',
      isError: false,
      durationMs: 100,
      structuredContent: [{ type: 'text', text: 'hello' }],
    };
    const result = outcomeToResult(outcome);
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
});
