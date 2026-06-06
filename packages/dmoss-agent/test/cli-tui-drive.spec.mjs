#!/usr/bin/env node
/**
 * Drive the REAL DmossTui like a human (ink-testing stdin) and assert the behaviors
 * behind the reported bugs:
 *   - running a command must NOT garble the frame (flexShrink squash / overdraw)
 *   - tall output must be readable: newest lines shown by default, PageUp/PageDown scroll
 *   - the header scrolls away so small terminals still show content
 *   - inline Chinese/CJK input, slash-menu arrow nav + Tab completion
 *
 * Run: npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/cli-tui-drive.spec.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DmossTui } from '../dist/cli/tui.js';

const require = createRequire(import.meta.url);
const inkEntry = require.resolve('ink');
const { default: CursorContext } = await import(
  path.join(path.dirname(inkEntry), 'components/CursorContext.js'),
);

const ESC = String.fromCharCode(27);
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
const setRows = (r) => Object.defineProperty(process.stdout, 'rows', { value: r, configurable: true });

const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));

function makeAgent() {
  return {
    config: {
      model: 'deepseek-v4-pro',
      provider: 'openai-compatible',
      sessionStore: { listSessions: async () => [], loadMessages: async () => [] },
    },
    tools: { getAll: () => [], size: 0 },
    registerPreToolHook() {},
    registerPostToolHook() {},
    // eslint-disable-next-line require-yield
    async *streamChat() {},
  };
}
const skillLearner = { async maybeLearnFromSession() {} };
const runtime = {
  workspace: '/Users/d-robotics/Desktop/RDK_Studio/moss/packages/dmoss-agent',
  configDir: '/tmp/dmoss-test/config',
  runtimeDir: '/tmp/dmoss-test/runtime',
};
const mount = () => render(React.createElement(
  CursorContext.Provider,
  { value: { setCursorPosition() {} } },
  React.createElement(DmossTui, { agent: makeAgent(), skillLearner, runtime, sessionKey: 'cli' }),
));

// A garbled frame from the flexShrink-squash bug looks like "deepseek-v4-pro" or the
// cwd path bleeding into an adjacent field. None of these may ever appear.
function assertNoCrush(frame, ctx) {
  const s = strip(frame);
  assert.doesNotMatch(s, /deepseek-v4-pro\S/, `${ctx}: model value overlaps next field (squash)`);
  assert.doesNotMatch(s, /dmoss-agent\s*│?\s*(model:|>_)/, `${ctx}: cwd line merged into another (squash)`);
}
const inputLine = (frame) =>
  strip(frame).split('\n').filter((l) => /│\s+>/.test(l) && !/RDK Studio/.test(l)).pop() || '';
const selectedCmd = (frame) => {
  const row = strip(frame).split('\n').find((l) => /^\s*[❯>]\s+\/[a-z]/.test(l));
  const m = row && row.match(/(\/[a-z]+)/);
  return m ? m[1] : null;
};
async function runSlashCommand(stdin, lastFrame, cmd) {
  stdin.write(cmd);
  await wait();
  stdin.write('\r');
  await wait(180);
  return lastFrame();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('/status renders cleanly (no squash) and shows the newest lines by default', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/status');
  assertNoCrush(f, '/status @24');
  assert.match(strip(f), /mesh: disabled/, 'newest /status line (mesh) should be visible at the bottom');
  cleanup();
});

test('PageUp reveals the top of a tall output; PageDown re-pins to the bottom', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  await runSlashCommand(stdin, lastFrame, '/status');

  let topSeen = false;
  for (let i = 0; i < 6 && !topSeen; i += 1) {
    stdin.write(PAGE_UP);
    await wait(110);
    const s = strip(lastFrame());
    topSeen = /\bStatus\b/.test(s) && /session: cli/.test(s);
  }
  assert.ok(topSeen, 'PageUp should scroll up to the first /status lines (Status/session)');

  let bottomSeen = false;
  for (let i = 0; i < 8 && !bottomSeen; i += 1) {
    stdin.write(PAGE_DOWN);
    await wait(110);
    bottomSeen = /mesh: disabled/.test(strip(lastFrame()));
  }
  assert.ok(bottomSeen, 'PageDown should return to the newest line (mesh)');
  cleanup();
});

test('a tall command stays readable on a small terminal (header scrolls away)', async () => {
  setRows(16);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/status');
  assertNoCrush(f, '/status @16');
  assert.match(strip(f), /mesh: disabled/, 'small terminal must still show the newest /status content');
  cleanup();
});

test('Chinese/CJK text is typed inline into the input box', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  stdin.write('你好世界');
  await wait(120);
  assert.match(inputLine(lastFrame()), /你好世界/, 'CJK input should appear in the prompt');
  cleanup();
});

test('slash menu: arrow keys move the selection and Tab completes it', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  stdin.write('/');
  await wait();
  const s0 = selectedCmd(lastFrame());
  stdin.write(DOWN);
  await wait();
  const s1 = selectedCmd(lastFrame());
  stdin.write(UP);
  await wait();
  const s0b = selectedCmd(lastFrame());
  assert.ok(s0 && s1 && s0 !== s1, 'Down should move the selection to a different command');
  assert.equal(s0b, s0, 'Up should return to the previous command');
  stdin.write('\t');
  await wait(120);
  assert.ok(inputLine(lastFrame()).includes(s0b), `Tab should complete the input to ${s0b}`);
  cleanup();
});

test('running several commands in a row never accumulates garbling, and scrollback works', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  for (const cmd of ['/status', '/permissions', '/tools']) {
    const f = await runSlashCommand(stdin, lastFrame, cmd);
    assertNoCrush(f, `after ${cmd}`);
  }
  let sawFirst = false;
  for (let i = 0; i < 12 && !sawFirst; i += 1) {
    stdin.write(PAGE_UP);
    await wait(100);
    const s = strip(lastFrame());
    sawFirst = /\bStatus\b/.test(s) && /session: cli/.test(s);
  }
  assert.ok(sawFirst, 'PageUp should reach the first command output after several commands');
  cleanup();
});

test('mouse wheel scrolls the transcript and never types mouse bytes into the box', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  await runSlashCommand(stdin, lastFrame, '/status');
  const WHEEL_UP = `${ESC}[<64;10;12M`;
  const WHEEL_DOWN = `${ESC}[<65;10;12M`;
  let topSeen = false;
  for (let i = 0; i < 10 && !topSeen; i += 1) {
    stdin.write(WHEEL_UP);
    await wait(70);
    const s = strip(lastFrame());
    topSeen = /\bStatus\b/.test(s) && /session: cli/.test(s);
  }
  assert.ok(topSeen, 'mouse wheel up should scroll to the top of a tall output');
  assert.doesNotMatch(
    inputLine(lastFrame()),
    /\[<|64;1|65;1|;\d+;\d+[Mm]/,
    'mouse report bytes must never be typed into the prompt box',
  );
  let bottomSeen = false;
  for (let i = 0; i < 12 && !bottomSeen; i += 1) {
    stdin.write(WHEEL_DOWN);
    await wait(70);
    bottomSeen = /mesh: disabled/.test(strip(lastFrame()));
  }
  assert.ok(bottomSeen, 'mouse wheel down should return to the newest line');
  cleanup();
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    process.stderr.write(`  ok  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stderr.write(`  FAIL ${name}\n`);
    process.stderr.write(`       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}\n`);
  }
}

if (failures > 0) {
  console.error(`[FAIL] ${failures} of ${tests.length} TUI drive tests failed`);
  process.exit(1);
}
console.log(`[PASS] TUI drive tests (${tests.length} interactive scenarios)`);
process.exit(0);
