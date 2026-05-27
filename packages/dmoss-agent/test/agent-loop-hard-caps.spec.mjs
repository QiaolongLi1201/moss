import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveCaps } from '../dist/core/loop/agent-loop.js';

describe('resolveEffectiveCaps', () => {
  it('returns defaults when hardCaps is undefined', () => {
    const caps = resolveEffectiveCaps(undefined);
    assert.equal(caps.maxMessageCount, 200);
    assert.equal(caps.maxTotalTokens, 125_000);
    assert.equal(caps.maxConsecutiveTurnErrors, 2);
    assert.equal(caps.maxOutputContinuations, 3);
  });

  it('applies custom positive values', () => {
    const caps = resolveEffectiveCaps({ maxMessageCount: 100, maxTotalTokens: 64_000 });
    assert.equal(caps.maxMessageCount, 100);
    assert.equal(caps.maxTotalTokens, 64_000);
    assert.equal(caps.maxConsecutiveTurnErrors, 2);
    assert.equal(caps.maxOutputContinuations, 3);
  });

  it('rejects zero values', () => {
    const caps = resolveEffectiveCaps({ maxMessageCount: 0 });
    assert.equal(caps.maxMessageCount, 200);
  });

  it('rejects NaN values', () => {
    const caps = resolveEffectiveCaps({ maxTotalTokens: NaN });
    assert.equal(caps.maxTotalTokens, 125_000);
  });

  it('rejects negative values', () => {
    const caps = resolveEffectiveCaps({ maxConsecutiveTurnErrors: -1 });
    assert.equal(caps.maxConsecutiveTurnErrors, 2);
  });

  it('partial override keeps other defaults', () => {
    const caps = resolveEffectiveCaps({ maxOutputContinuations: 10 });
    assert.equal(caps.maxMessageCount, 200);
    assert.equal(caps.maxOutputContinuations, 10);
  });
});
