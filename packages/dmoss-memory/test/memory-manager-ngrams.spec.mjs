import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryManager } from '../dist/memory-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

test('extractTerms limits n-gram generation on long tokens', async () => {
  const testDir = join(tmpdir(), `memory-ngram-${Date.now()}`);
  const manager = new MemoryManager(testDir);
  
  const longToken = 'a'.repeat(1000);
  const terms = manager.extractTerms(longToken);
  
  assert(terms.length < 10000, 
    `Terms should be capped, got ${terms.length}`);
  
  rmSync(testDir, { recursive: true, force: true });
});
