#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageDir = path.resolve(scriptDir, '..');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageDir = path.resolve(argValue('--package-dir') || defaultPackageDir);
const zeroConfigPath = path.join(packageDir, 'zero-config-default.json');
const markerPath = path.join(packageDir, '.zero-config-default.generated');

if (!fs.existsSync(markerPath)) {
  process.exit(0);
}

fs.rmSync(zeroConfigPath, { force: true });
fs.rmSync(markerPath, { force: true });
console.error('[zero-config] removed generated zero-config-default.json after package packing');
