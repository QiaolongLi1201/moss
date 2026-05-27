import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, hybridScore } from '../dist/memory-embedding.js';
import { MemoryManager } from '../dist/memory-manager.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('cosineSimilarity', () => {
  it('identical vectors return 1.0', () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
  });

  it('orthogonal vectors return 0.0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-6);
  });

  it('opposite vectors return -1.0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1.0)) < 1e-6);
  });

  it('zero vector returns 0.0', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  });

  it('similar vectors return high score', () => {
    const score = cosineSimilarity([1, 2, 3], [1.1, 2.1, 3.1]);
    assert.ok(score > 0.99);
  });
});

describe('hybridScore', () => {
  it('default weight 0.3 blends correctly', () => {
    const score = hybridScore(0.8, 0.6);
    assert.ok(Math.abs(score - (0.8 * 0.7 + 0.6 * 0.3)) < 1e-6);
  });

  it('custom weight applies correctly', () => {
    const score = hybridScore(1.0, 0.0, 0.5);
    assert.ok(Math.abs(score - 0.5) < 1e-6);
  });

  it('zero semantic weight returns keyword score', () => {
    const score = hybridScore(0.7, 0.9, 0.0);
    assert.ok(Math.abs(score - 0.7) < 1e-6);
  });
});

describe('MemoryManager with embedding provider', () => {
  let dir;
  let mgr;
  const mockProvider = {
    dimensions: 3,
    async embed(texts) {
      return texts.map(t => {
        if (t.includes('cat')) return [1, 0, 0];
        if (t.includes('dog')) return [0.9, 0.1, 0];
        if (t.includes('car')) return [0, 0, 1];
        if (t.includes('pet') || t.includes('animal')) return [0.8, 0.2, 0];
        return [0.33, 0.33, 0.33];
      });
    },
  };

  it('hybrid search ranks semantically similar entries higher', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moss-embed-'));
    mgr = new MemoryManager(dir, mockProvider);
    await mgr.add('cat is a pet', 'memory');
    await mgr.add('dog is a pet', 'memory');
    await mgr.add('car is a pet', 'memory');
    const results = await mgr.search('pet', 3);
    assert.equal(results.length, 3);
    const carResult = results.find(r => r.entry.content === 'car is a pet');
    const catResult = results.find(r => r.entry.content === 'cat is a pet');
    assert.ok(catResult.score > carResult.score);
    await rm(dir, { recursive: true, force: true });
  });

  it('embeddings survive reload', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moss-embed-'));
    const mgr1 = new MemoryManager(dir, mockProvider);
    await mgr1.add('cat facts', 'memory');
    const mgr2 = new MemoryManager(dir, mockProvider);
    const results = await mgr2.search('cat', 1);
    assert.ok(results.length > 0);
    await rm(dir, { recursive: true, force: true });
  });

  it('clear() removes embeddings', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moss-embed-'));
    mgr = new MemoryManager(dir, mockProvider);
    await mgr.add('cat', 'memory');
    await mgr.clear();
    const results = await mgr.search('cat', 1);
    assert.equal(results.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it('cosineSimilarity handles different-length vectors', async () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1, 0.5]), 0);
    assert.equal(cosineSimilarity([], [1, 2]), 0);
  });

  it('delete() removes embedding', async () => {
    dir = await mkdtemp(join(tmpdir(), 'moss-embed-'));
    mgr = new MemoryManager(dir, mockProvider);
    const id = await mgr.add('cat', 'memory');
    await mgr.delete(id);
    const results = await mgr.search('cat', 1);
    assert.equal(results.length, 0);
    await rm(dir, { recursive: true, force: true });
  });
});
