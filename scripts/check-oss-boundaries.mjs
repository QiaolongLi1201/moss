#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const sourceExt = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|md)$/;
const packages = [
  'packages/dmoss',
  'packages/dmoss-agent',
  'packages/dmoss-memory',
  'packages/dmoss-skills',
  'packages/dmoss-teaching',
  'packages/create-dmoss-app',
];

const forbiddenPathFragments = [
  '/server/',
  '/electron/',
  '/config/',
  'rdk-studio-provider.defaults.json',
  'rdk-studio-image-provider.defaults.json',
];

const forbiddenText = [
  /\bfrom\s+['"](?:\.\.?\/)*(?:server|electron|config)(?:\/|['"])/,
  /\bimport\s*\(\s*['"](?:\.\.?\/)*(?:server|electron|config)(?:\/|['"])/,
  /config\/rdk-studio-[^'"\s]+\.defaults\.json/,
  /\brdk-[a-f0-9]{32,}\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/,
  /\bbce-v3\/[A-Za-z0-9/_-]{30,}\b/,
  /\b106\.53\.70\.59\b/,
  /\bqiaolongli\b/i,
];

const allowedFakeFragments = [
  'sk-proj-abc123def456ghi789jkl',
  'sk-ant-oat-abcdef1234567890ghij',
  'sk-ant-api03-abcdef1234567890ghij',
  'sk-ant-api03-abcdef1234567890ghijklmnopqrstuv',
  'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef',
  'sk-ant-api03-aaa1234567890123456789',
  'sk-test-00000000000000000000',
  'sk-xxx',
  'sk-xxxxxxxx',
];

const findings = [];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function lineAt(body, index) {
  return body.slice(0, index).split(/\r?\n/).length;
}

/**
 * Files that are git-ignored can never be committed, so they sit outside this
 * check's threat model (credentials entering the public repo / its history).
 * Scanning them produces false positives on documented publish-time artifacts
 * — e.g. `packages/dmoss-agent/zero-config-default.json` (gitignored;
 * generated at publish; intentionally carries a PUBLIC gateway token per
 * zero-config-default.example.json) — and turns `verify` permanently red on
 * any machine where such an artifact exists locally.
 *
 * Tracked files and untracked-but-committable files are still fully scanned.
 * If git is unavailable, we conservatively scan everything — the failure mode
 * keeps the check stronger, never weaker.
 */
function gitIgnoredSubset(files) {
  if (files.length === 0) return new Set();
  const relFiles = files.map((f) => path.relative(repoRoot, f));
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin', '-z'], {
      cwd: repoRoot,
      input: relFiles.join('\0'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split('\0').filter(Boolean).map((p) => path.join(repoRoot, p)));
  } catch (err) {
    // git check-ignore exits 1 when NO path is ignored — that is the normal
    // "nothing to skip" outcome, not an error.
    if (err && typeof err.status === 'number' && err.status === 1) return new Set();
    return new Set();
  }
}

for (const relPkg of packages) {
  const absPkg = path.join(repoRoot, relPkg);
  if (!fs.existsSync(absPkg)) {
    findings.push(`${relPkg}: missing package directory`);
    continue;
  }
  const walked = walk(absPkg);
  const gitIgnored = gitIgnoredSubset(walked);
  for (const file of walked) {
    if (gitIgnored.has(file)) continue;
    const rel = path.relative(repoRoot, file);
    const normalized = `/${rel.replaceAll(path.sep, '/')}`;
    for (const fragment of forbiddenPathFragments) {
      if (normalized.includes(fragment)) {
        findings.push(`${rel}: forbidden path fragment ${fragment}`);
      }
    }
    if (!sourceExt.test(file)) continue;
    const body = fs.readFileSync(file, 'utf8');
    for (const pattern of forbiddenText) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      const matches = [...body.matchAll(globalPattern)];
      for (const match of matches) {
        if (allowedFakeFragments.some((fragment) => match[0] === fragment)) continue;
        findings.push(`${rel}:${lineAt(body, match.index || 0)} forbidden OSS boundary text: ${match[0].slice(0, 80)}`);
      }
    }
  }
}

const builtDirs = [];
for (const relPkg of packages) {
  const dist = path.join(repoRoot, relPkg, 'dist');
  if (!fs.existsSync(dist)) continue;
  const relDist = path.relative(repoRoot, dist);
  const tracked = execFileSync('git', ['ls-files', relDist], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (tracked) builtDirs.push(relDist);
}
for (const rel of builtDirs) findings.push(`${rel}: dist directory must not be committed in the OSS repo`);

if (findings.length > 0) {
  console.error('[oss-boundaries] FAIL');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('[oss-boundaries] OK');
