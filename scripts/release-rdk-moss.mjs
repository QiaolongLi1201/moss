#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const releasePackages = [
  { name: '@rdk-moss/core', dir: 'packages/dmoss' },
  { name: '@rdk-moss/memory', dir: 'packages/dmoss-memory' },
  { name: '@rdk-moss/skills', dir: 'packages/dmoss-skills' },
  { name: '@rdk-moss/agent', dir: 'packages/dmoss-agent' },
  { name: '@rdk-moss/teaching', dir: 'packages/dmoss-teaching' },
];

const internalNames = new Set(releasePackages.map((pkg) => pkg.name));

function usage() {
  console.log([
    'Usage:',
    '  node scripts/release-rdk-moss.mjs <version> [--publish] [--skip-build]',
    '',
    'Default mode is dry-run. Add --publish for a real npm publish.',
    'The script keeps @rdk-moss/* package versions aligned and publishes in dependency order.',
    '',
    'Examples:',
    '  node scripts/release-rdk-moss.mjs 0.3.7',
    '  node scripts/release-rdk-moss.mjs 0.3.7 --publish',
  ].join('\n'));
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const shown = [command, ...args].join(' ');
  console.error(`[release] ${shown}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`${shown}: ${result.error.message}`);
  if ((result.status ?? 0) !== 0) fail(`${shown}: exited ${result.status}`);
}

function requireNpmAuth() {
  const result = spawnSync('npm', ['whoami'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail('npm is not logged in. Run `npm login` or configure an npm auth token before using --publish.');
  }
  console.error(`[release] npm authenticated as ${result.stdout.trim()}`);
}

function readPackageJson(dir) {
  const file = path.join(repoRoot, dir, 'package.json');
  return { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function writePackageJson(file, json) {
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function syncCreateDmossAppFallback(version) {
  const file = path.join(repoRoot, 'packages/create-dmoss-app/index.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const pattern = /const DEFAULT_MOSS_VERSION_RANGE = '\^[^']+';/;
  if (!pattern.test(source)) {
    fail('packages/create-dmoss-app/index.mjs: missing DEFAULT_MOSS_VERSION_RANGE');
  }
  const next = source.replace(pattern, `const DEFAULT_MOSS_VERSION_RANGE = '^${version}';`);
  fs.writeFileSync(file, next);
}

function syncVersions(version) {
  for (const pkg of releasePackages) {
    const { file, json } = readPackageJson(pkg.dir);
    json.version = version;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (!json[field]) continue;
      for (const depName of Object.keys(json[field])) {
        if (internalNames.has(depName)) json[field][depName] = `^${version}`;
      }
    }
    writePackageJson(file, json);
  }
  syncCreateDmossAppFallback(version);
  run('npm', ['install', '--package-lock-only']);
}

function packageExists(name, version) {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0 && result.stdout.trim()) return true;
  return false;
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}

const version = args.find((arg) => !arg.startsWith('-'));
if (!version) {
  usage();
  fail('missing release version');
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`invalid semver-ish version: ${version}`);
}

const realPublish = args.includes('--publish');
const skipBuild = args.includes('--skip-build');

if (realPublish) requireNpmAuth();

syncVersions(version);

if (!skipBuild) {
  for (const pkg of releasePackages) run('npm', ['run', 'build', '-w', pkg.name]);
}

for (const pkg of releasePackages) {
  if (packageExists(pkg.name, version)) {
    console.error(`[release] ${pkg.name}@${version} already exists on npm; skipping`);
    continue;
  }
  const publishArgs = ['publish', `--workspace=${pkg.name}`, '--access', 'public'];
  if (!realPublish) publishArgs.push('--dry-run');
  run('npm', publishArgs);
}

console.error(`[release] ${realPublish ? 'published' : 'dry-run complete'} @rdk-moss/* ${version}`);
