#!/usr/bin/env node
/**
 * Regressions:
 *  1. A slash command whose handler throws must render an error line, not
 *     crash the whole TUI process (unhandled rejection). Reproduced with a
 *     host-embedded agent missing tools.getNames() + /examples.
 *  2. /diff outside a git repository must print one friendly line instead of
 *     dumping git's usage screen.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui-command-guard.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DmossTui } from '../dist/cli/tui.js';

const require = createRequire(import.meta.url);
const inkEntry = require.resolve('ink');
const { default: CursorContext } = await import(
  pathToFileURL(path.join(path.dirname(inkEntry), 'components/CursorContext.js')).href,
);
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-tui-guard-'));

function makeAgent() {
  return {
    config: {
      model: 'm',
      provider: 'openai-compatible',
      sessionStore: { listSessions: async () => [], loadMessages: async () => [] },
    },
    asyncTasks: { list: () => [], readCompletion: () => undefined },
    // Intentionally WITHOUT getNames() — a host-embedded registry stub.
    tools: { getAll: () => [], size: 0 },
    async getGoal() { return undefined; },
    async compactSession() { return { compacted: false, summaryChars: 0, droppedMessages: 0, tokensAfter: 1 }; },
    registerPreToolHook() {}, registerPostToolHook() {},
    async *streamChat() { yield { type: 'done', result: { text: '', toolCalls: [], stopReason: 'end_turn' } }; },
  };
}
const runtime = {
  workspace: scratch, // not a git repository
  configDir: path.join(scratch, 'config'),
  runtimeDir: path.join(scratch, '.moss'),
  config: { provider: 'openai-compatible', safetyMode: 'workspace-write', approvalPolicy: 'prompt' },
};

const { stdin, frames, lastFrame } = render(React.createElement(
  CursorContext.Provider, { value: { setCursorPosition() {} } },
  React.createElement(DmossTui, {
    agent: makeAgent(),
    skillLearner: { async maybeLearnFromSession() {} },
    runtime,
    sessionKey: 'guard',
  }),
));
await wait(300);

// 1) /examples → handler throws (no getNames) → error line, process alive.
stdin.write('/examples');
await wait(150);
stdin.write('\r');
await wait(450);
let all = frames.map(strip).join('\n');
assert.match(all, /Command failed:/, '/examples failure must surface as an error line');
assert.ok(strip(lastFrame()).length > 0, 'TUI must still be rendering after a failed command');
console.log('  [PASS] throwing slash command renders an error instead of crashing');

// 2) /permissions with a partial host config: the contract is "never crash
// the session" — it must either render the panel or surface an error line.
stdin.write('/permissions');
await wait(150);
stdin.write('\r');
await wait(450);
all = frames.map(strip).join('\n');
assert.match(
  all,
  /Permissions & Config|Command failed:/,
  '/permissions with partial config must render or fail gracefully',
);
assert.ok(strip(lastFrame()).includes('Ask Moss'), 'TUI must still be interactive after /permissions');
console.log('  [PASS] /permissions never crashes the session on partial config');

// 3) /diff outside a git repo → one friendly line, no usage dump.
stdin.write('/diff');
await wait(150);
stdin.write('\r');
await wait(700);
all = frames.map(strip).join('\n');
assert.match(all, /Not a git repository/i, '/diff must explain the workspace is not a git repo');
assert.doesNotMatch(all, /--pickaxe-all/, 'git usage screen must not be dumped to the transcript');
console.log('  [PASS] /diff outside git prints a friendly one-liner');

cleanup();
fs.rmSync(scratch, { recursive: true, force: true });
console.log('[PASS] TUI command guard');
process.exit(0);
