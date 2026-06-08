#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-update-check.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForCliUpdate,
  formatUpdateNotice,
} from '../dist/cli/update-check.js';
import { completeInteractiveCommand } from '../dist/cli/repl.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-update-check-'));
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice?.latestVersion, '0.3.5');
  assert.match(formatUpdateNotice(notice), /0\.3\.4 -> 0\.3\.5/);
  assert.match(formatUpdateNotice(notice), /npm i -g @rdk-moss\/agent@latest/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'latest-version.json'), 'utf-8')).latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.6' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.7' }), { status: 200 });
    },
  });
  assert.equal(calls, 0);
  assert.equal(notice?.latestVersion, '0.3.6');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.1' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 1, 'cache older than current install should not suppress registry checks');
  assert.equal(notice?.latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.4' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    noUpdateCacheMaxAgeMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 1, 'expired no-update cache should refresh quickly after new releases');
  assert.equal(notice?.latestVersion, '0.3.5');
}

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'latest-version.json'), JSON.stringify({ checkedAt: 1000, latestVersion: '0.3.4' }));
  let calls = 0;
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.4',
    now: 1000 + 60 * 1000,
    noUpdateCacheMaxAgeMs: 5 * 60 * 1000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 });
    },
  });
  assert.equal(calls, 0, 'fresh no-update cache should still avoid registry checks');
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.5',
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.5',
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice, null);
}

{
  const dir = tmpDir();
  const notice = await checkForCliUpdate({
    configDir: dir,
    currentVersion: '0.3.6',
    fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.5' }), { status: 200 }),
  });
  assert.equal(notice, null);
}

{
  const [matches] = completeInteractiveCommand('/up');
  assert.deepEqual(matches, ['/upgrade']);
}

console.log('[PASS] CLI update check is cached, quiet on failure, and completer works');
