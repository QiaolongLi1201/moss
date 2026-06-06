#!/usr/bin/env node
/**
 * Drive the REAL DmossTui like a human (ink-testing stdin) and assert the behaviors
 * behind the reported bugs:
 *   - running a command must NOT garble the frame (flexShrink squash / overdraw)
 *   - tall output keeps EVERY line (history → <Static> → terminal scrollback, nothing clipped)
 *   - mouse-report bytes are ignored, never typed into the prompt box
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

test('a tall output keeps every line — history flows to native scrollback, nothing clipped', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/status');
  // /status is taller than 24 rows. With the <Static> history model every committed
  // line is written to the terminal (its own scrollback), so the FIRST line and the
  // LAST line are both present at once — the user scrolls natively to read it all,
  // nothing is dropped the way a fixed-height in-place frame would clip it.
  const s = strip(f);
  assert.match(s, /\bStatus\b/, 'the first /status line must be present (not clipped off the top)');
  assert.match(s, /session: cli/, 'an early /status line must be present');
  assert.match(s, /mesh: disabled/, 'the newest /status line must be present');
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

test('running several commands in a row never garbles, and all output is retained in scrollback', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  for (const cmd of ['/status', '/permissions', '/tools']) {
    const f = await runSlashCommand(stdin, lastFrame, cmd);
    assertNoCrush(f, `after ${cmd}`);
  }
  // Every command's output stays in the committed <Static> history (terminal
  // scrollback), so the earliest command is still present after later ones ran — it is
  // never truncated or overwritten in place the way a fixed redraw frame would.
  const s = strip(lastFrame());
  assert.match(s, /\bStatus\b/, 'the first command (/status) output must still be present');
  assert.match(s, /session: cli/, 'an early /status line must still be present after later commands');
  cleanup();
});

test('mouse-report bytes are ignored — a stray wheel never types into the prompt or fires keys', async () => {
  // The regression we guard against (see the user screenshot): with mouse reporting on
  // — whether ours or a multiplexer's — the terminal forwards wheel events as SGR byte
  // sequences. We no longer enable mouse reporting (so the terminal scrolls natively),
  // but any forwarded bytes must NEVER land in the input box ("the wheel turned into
  // [<64;… text") nor trigger an action.
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  stdin.write('hello');
  await wait(80);
  const WHEEL_UP = `${ESC}[<64;10;12M`;
  const WHEEL_DOWN = `${ESC}[<65;10;12M`;
  const LEGACY_WHEEL = `${ESC}[M\x60\x21\x21`;
  for (const seq of [WHEEL_UP, WHEEL_DOWN, WHEEL_UP, LEGACY_WHEEL]) {
    stdin.write(seq);
    await wait(50);
  }
  const line = inputLine(lastFrame());
  assert.match(line, /hello/, 'real typed text must survive the wheel events');
  assert.doesNotMatch(
    line,
    /\[<|64;1|65;1|;\d+;\d+[Mm]|\[M/,
    'mouse report bytes must never be typed into the prompt box',
  );
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
