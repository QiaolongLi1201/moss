#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = join(process.cwd(), 'test');

try {
  readdirSync(testDir);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(`[test] missing test directory: ${testDir}`);
    process.exit(1);
  }
  throw err;
}

function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(file));
    } else if (entry.isFile() && entry.name.endsWith('.spec.mjs')) {
      files.push(file);
    }
  }
  return files;
}

const testFiles = collectTestFiles(testDir).sort();

if (testFiles.length === 0) {
  console.error(`[test] no *.spec.mjs files found in ${testDir}`);
  process.exit(1);
}

for (const file of testFiles) {
  console.error(`[test] ${file}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.error(`[test] passed ${testFiles.length} file(s)`);
