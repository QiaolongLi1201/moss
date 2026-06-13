#!/usr/bin/env node
/**
 * Test: MemoryManager write chain consistency across all write methods.
 * Ensures that concurrent writes maintain FIFO ordering regardless of method.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const { MemoryManager } = await import(pathToFileURL(distJs).href);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-write-chain-'));

// Test: touchAccessed should use same write chain pattern as other methods
{
  const mm = new MemoryManager(tmpDir);
  
  // Add an entry
  const id1 = await mm.add('test content 1', 'memory');
  
  // Search (which calls touchAccessed internally) then add
  const searchPromise = mm.search('test', 1);
  const addPromise = mm.add('test content 2', 'memory');
  
  await Promise.all([searchPromise, addPromise]);
  
  // Verify both operations completed and are in the index
  const all = await mm.getAll();
  assert.equal(all.length, 2, 'Both entries should exist after concurrent search+add');
  
  // Verify accessCount was properly incremented (from search -> touchAccessed)
  const accessed = all.find(e => e.id === id1);
  assert.ok(accessed.accessCount > 0, 'touchAccessed should have incremented accessCount');
  
  console.log('  [PASS] touchAccessed uses consistent write chain pattern');
}

await fs.rm(tmpDir, { recursive: true, force: true });
console.log('[write-chain-consistency.spec] PASS');
