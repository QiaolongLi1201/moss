import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getPackageJsonPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json',
  );
}

export function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(getPackageJsonPath(), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
