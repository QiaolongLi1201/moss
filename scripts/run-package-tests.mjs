#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = join(process.cwd(), 'test');

let entries;
try {
  entries = readdirSync(testDir);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(`[test] missing test directory: ${testDir}`);
    process.exit(1);
  }
  throw err;
}

const testFiles = entries
  .filter((name) => name.endsWith('.spec.mjs'))
  .map((name) => join(testDir, name))
  .filter((file) => statSync(file).isFile())
  .sort();

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
