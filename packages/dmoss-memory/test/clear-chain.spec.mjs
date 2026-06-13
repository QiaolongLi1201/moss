#!/usr/bin/env node
/**
 * Test: MemoryManager.clear() properly sequences write chain for subsequent operations.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const { MemoryManager } = await import(pathToFileURL(distJs).href);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-clear-chain-'));

// Test: clear() followed by add() should maintain proper sequencing
{
  const mm = new MemoryManager(tmpDir);
  
  // Add initial entries
  await mm.add('entry 1', 'memory');
  await mm.add('entry 2', 'memory');
  
  let all = await mm.getAll();
  assert.equal(all.length, 2, 'Should have 2 entries before clear');
  
  // Clear and immediately add
  await mm.clear();
  await mm.add('entry 3', 'memory');
  
  // Verify the result
  all = await mm.getAll();
  assert.equal(all.length, 1, 'Should have 1 entry after clear+add');
  assert.equal(all[0].content, 'entry 3', 'Entry after clear+add should be "entry 3"');
  
  console.log('  [PASS] clear() properly sequences write chain');
}

await fs.rm(tmpDir, { recursive: true, force: true });
console.log('[clear-chain.spec] PASS');
