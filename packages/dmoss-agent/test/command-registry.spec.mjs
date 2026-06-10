#!/usr/bin/env node
/**
 * Slash-command registry (phase 1): dispatch matching, pilot commands, and
 * the shared unknown-command UX. See docs/slash-command-architecture.md.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import {
  findRegistryCommand,
  runRegistryCommand,
  unknownSlashCommandLines,
} from '../dist/cli/commands/registry.js';

function fakeCtx(overrides = {}) {
  const said = [];
  const prefilled = [];
  const tools = new Map();
  return {
    said,
    prefilled,
    agent: {
      config: { extraPromptLayers: [] },
      tools: {
        get: (n) => tools.get(n),
        remove: (n) => tools.delete(n),
        register: (t) => tools.set(t.name, t),
      },
    },
    runtime: {},
    sessionKey: 'test',
    workspace: '/tmp',
    locale: undefined,
    surface: 'repl',
    say(kind, text) {
      said.push({ kind, text });
    },
    prefillInput(text) {
      prefilled.push(text);
    },
    ...overrides,
  };
}

// ── matching ────────────────────────────────────────────────────────────────

{
  assert.equal(findRegistryCommand('hello world'), null, 'non-slash input never matches');
  assert.equal(findRegistryCommand('/unknown thing'), null, 'unmigrated commands fall through to legacy chains');
  assert.equal(findRegistryCommand('/versions'), null, 'prefix collisions must not match');
  const version = findRegistryCommand('/version');
  assert.equal(version?.spec.name, '/version');
  assert.equal(version?.args, '');
  const connect = findRegistryCommand('  /connect root@10.0.0.1 --port 22  ');
  assert.equal(connect?.spec.name, '/connect');
  assert.equal(connect?.args, 'root@10.0.0.1 --port 22');
}

// ── /version ────────────────────────────────────────────────────────────────

{
  const ctx = fakeCtx();
  assert.equal(await runRegistryCommand('/version', ctx), true);
  assert.equal(ctx.said.length, 1);
  assert.match(ctx.said[0].text, /^moss v\d+\.\d+\.\d+/);
  assert.equal(ctx.said[0].kind, 'system');
}

// ── /connect: usage error path stays in the registry ───────────────────────

{
  const ctx = fakeCtx();
  assert.equal(await runRegistryCommand('/connect', ctx), true);
  assert.equal(ctx.said[0].kind, 'error');
  assert.match(ctx.said[0].text, /Usage: \/connect/);
  assert.equal(ctx.prefilled.length, 0);
}

// ── /disconnect with nothing connected ──────────────────────────────────────

{
  const ctx = fakeCtx();
  assert.equal(await runRegistryCommand('/disconnect', ctx), true);
  assert.match(ctx.said[0].text, /No board is connected/);
}

// ── phase 2: pure-output commands and aliases ───────────────────────────────

{
  for (const [input, pattern] of [
    ['/upgrade', /upgrade|npm/i],
    ['/cost', /Session usage|usage/i],
  ]) {
    const ctx = fakeCtx();
    assert.equal(await runRegistryCommand(input, ctx), true, `${input} must be registry-handled`);
    assert.equal(ctx.said.length, 1, `${input} prints exactly once`);
    assert.match(ctx.said[0].text, pattern);
  }
  // alias resolution
  assert.equal(findRegistryCommand('/config')?.spec.name, '/permissions', '/config aliases /permissions');
  assert.equal(findRegistryCommand('/quick_start')?.spec.name, '/quickstart');
  assert.equal(findRegistryCommand('/start')?.spec.name, '/quickstart');
}

// ── fall-through contract ───────────────────────────────────────────────────

{
  const ctx = fakeCtx();
  assert.equal(await runRegistryCommand('/help', ctx), false, 'unmigrated commands return false');
  assert.equal(ctx.said.length, 0, 'fall-through must not print');
  assert.equal(await runRegistryCommand('/model', fakeCtx()), false, 'surface-local commands stay in their surfaces');
}

// ── unknown-command UX (shared by both surfaces) ────────────────────────────

{
  const en = unknownSlashCommandLines('/slack', { suggestion: null });
  assert.equal(en.length, 3);
  assert.match(en[0], /Unknown command: \/slack/);
  assert.match(en[2], /never reaches the model/);

  const zh = unknownSlashCommandLines('/slack', { suggestion: '/skills', locale: 'zh_CN.UTF-8' });
  assert.match(zh[0], /未知命令：\/slack/);
  assert.match(zh[1], /是想输入 \/skills 吗/);
  assert.match(zh[2], /不会发给模型/);
}

console.log('[PASS] command registry: matching, pilot commands, fall-through, unknown-command UX');
