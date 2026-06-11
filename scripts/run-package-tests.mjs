#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = join(process.cwd(), 'test');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function workspacePackages() {
  const packagesDir = join(repoRoot, 'packages');
  const out = new Map();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    if (typeof pkg.name === 'string') out.set(pkg.name, { dir: dirname(pkgPath), pkg });
  }
  return out;
}

function localPackageTargets() {
  const currentPkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(currentPkgPath)) return [];
  const current = { dir: process.cwd(), pkg: readJson(currentPkgPath) };
  const byName = workspacePackages();
  const deps = {
    ...(current.pkg.dependencies ?? {}),
    ...(current.pkg.devDependencies ?? {}),
    ...(current.pkg.peerDependencies ?? {}),
  };
  const targets = [current];
  for (const name of Object.keys(deps)) {
    const local = byName.get(name);
    if (local) targets.push(local);
  }
  return targets
    .filter(({ pkg }) => pkg.scripts?.build || pkg.exports)
    .map(({ dir }) => join(dir, 'dist'));
}

function distSnapshot(dir) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  let count = 0;
  let bytes = 0;
  let latestMtime = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(file);
      count += 1;
      bytes += stat.size;
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
    }
  }
  return `${count}:${bytes}:${Math.round(latestMtime)}`;
}

async function waitForStableDists() {
  const targets = localPackageTargets();
  if (targets.length === 0) return;
  const deadline = Date.now() + 5_000;
  let previous = null;
  while (Date.now() < deadline) {
    const snapshots = targets.map(distSnapshot);
    if (snapshots.every(Boolean)) {
      const next = snapshots.join('|');
      if (next === previous) return;
      previous = next;
    } else {
      previous = null;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

await waitForStableDists();

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
