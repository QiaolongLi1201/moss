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
import { pathToFileURL } from 'node:url';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { DmossTui } from '../dist/cli/tui.js';

const require = createRequire(import.meta.url);
const inkEntry = require.resolve('ink');
const { default: CursorContext } = await import(
  pathToFileURL(path.join(path.dirname(inkEntry), 'components/CursorContext.js')).href,
);

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
const setRows = (r) => Object.defineProperty(process.stdout, 'rows', { value: r, configurable: true });

const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));

function makeAgent(options = {}) {
  let goal;
  return {
    config: {
      model: 'deepseek-v4-pro',
      provider: 'openai-compatible',
      sessionStore: { listSessions: async () => [], loadMessages: async () => [] },
    },
    asyncTasks: {
      list: () => [],
      readCompletion: () => undefined,
    },
    tools: { getAll: () => [], size: 0 },
    async getGoal() {
      return goal;
    },
    async setGoal(sessionKey, objective) {
      goal = {
        sessionKey,
        objective,
        status: 'active',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
      };
      return goal;
    },
    async pauseGoal() {
      return goal;
    },
    async resumeGoal() {
      return goal;
    },
    async completeGoal() {
      return goal;
    },
    async blockGoal() {
      return goal;
    },
    async clearGoal() {
      goal = undefined;
    },
    async compactSession() {
      return {
        compacted: false,
        summaryChars: 0,
        droppedMessages: 0,
        tokensAfter: 42,
      };
    },
    registerPreToolHook() {},
    registerPostToolHook() {},
    // eslint-disable-next-line require-yield
    async *streamChat(sessionKey, message, chatOptions) {
      options.onStreamChat?.({ sessionKey, message, options: chatOptions });
    },
  };
}
const skillLearner = { async maybeLearnFromSession() {} };
const runtime = {
  workspace: '/Users/d-robotics/Desktop/RDK_Studio/moss/packages/dmoss-agent',
  configDir: '/tmp/dmoss-test/config',
  runtimeDir: '/tmp/dmoss-test/runtime',
};
const mount = (agent = makeAgent(), runtimeOverride = runtime) => render(React.createElement(
  CursorContext.Provider,
  { value: { setCursorPosition() {} } },
  React.createElement(DmossTui, { agent, skillLearner, runtime: runtimeOverride, sessionKey: 'cli' }),
));

// A garbled frame from the flexShrink-squash bug looks like "deepseek-v4-pro" or the
// cwd path bleeding into an adjacent field. None of these may ever appear.
function assertNoCrush(frame, ctx) {
  const s = strip(frame);
  assert.doesNotMatch(s, /deepseek-v4-pro\S/, `${ctx}: model value overlaps next field (squash)`);
  assert.doesNotMatch(s, /dmoss-agent\s*│?\s*(model:|>_)/, `${ctx}: cwd line merged into another (squash)`);
}
const inputLine = (frame) =>
  strip(frame).split('\n').filter((l) => /│\s+>/.test(l) && !/\bMoss\b/.test(l)).pop() || '';
const selectedCmd = (frame) => {
  const row = strip(frame).split('\n').find((l) => /^\s*[›❯>]\s+\/[a-z]/.test(l));
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
  assert.match(strip(f), /Details: \/status --verbose/, 'default /status should point to verbose details');
  assert.match(strip(f), /tools: 0/, 'default /status should keep the core runtime summary visible');
  cleanup();
});

test('a tall output keeps every line — history flows to native scrollback, nothing clipped', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/status --verbose');
  // /status --verbose is taller than 24 rows. With the <Static> history model every committed
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
  const f = await runSlashCommand(stdin, lastFrame, '/status --verbose');
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

test('prompt box Up/Down cycles previous chat prompts, not slash commands', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  stdin.write('first chat prompt');
  await wait();
  stdin.write('\r');
  await wait(180);
  await runSlashCommand(stdin, lastFrame, '/status');

  stdin.write(UP);
  await wait(120);
  assert.match(inputLine(lastFrame()), /first chat prompt/, 'Up should recall the last submitted chat prompt');
  assert.doesNotMatch(inputLine(lastFrame()), /\/status/, 'slash commands should not replace chat prompt history');

  stdin.write('\u0015');
  await wait();
  stdin.write('second chat prompt');
  await wait();
  stdin.write('\r');
  await wait(180);
  stdin.write(UP);
  await wait(120);
  assert.match(inputLine(lastFrame()), /second chat prompt/, 'Up should recall the newest submitted chat prompt');
  stdin.write(UP);
  await wait(120);
  {
    const line = inputLine(lastFrame());
    assert.match(line, /first chat prompt/, `Up again should move to the older chat prompt; got ${JSON.stringify(line)}`);
  }
  stdin.write(DOWN);
  await wait(120);
  assert.match(inputLine(lastFrame()), /second chat prompt/, 'Down should move toward newer chat prompts');
  stdin.write(DOWN);
  await wait(120);
  assert.doesNotMatch(inputLine(lastFrame()), /first chat prompt/, 'Down at the newest entry should restore the empty draft');
  cleanup();
});

test('slash menu: arrow keys move the selection and Tab completes it', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  stdin.write('/');
  await wait();
  assert.match(strip(lastFrame()), /›\s+\/[a-z]+/, 'slash menu should visibly mark the selected command');
  const s0 = selectedCmd(lastFrame());
  stdin.write(DOWN);
  await wait();
  const s1 = selectedCmd(lastFrame());
  assert.match(strip(lastFrame()), /›\s+\/[a-z]+/, 'Down should keep a visible selected-command marker');
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

test('/goal is visible and handled by the TUI', async () => {
  setRows(24);
  let mounted = mount();
  let { stdin, lastFrame } = mounted;
  await wait(140);
  stdin.write('/');
  await wait();
  assert.match(strip(lastFrame()), /\/goal\s+show or manage the persistent session goal/, 'slash menu should list /goal');
  assert.match(strip(lastFrame()), /\/compact\s+compress older conversation history/, 'slash menu should list /compact');
  cleanup();

  const agent = makeAgent();
  mounted = mount(agent);
  ({ stdin, lastFrame } = mounted);
  await wait(140);
  let f = await runSlashCommand(stdin, lastFrame, '/goal');
  assert.match(strip(f), /No goal is set|当前会话没有设置目标/, '/goal should be handled, not treated as unknown');
  assert.doesNotMatch(strip(f), /Unknown command: \/goal/);
  f = await runSlashCommand(stdin, lastFrame, '/goal set stabilize release');
  assert.match(strip(f), /Goal set: stabilize release|已设置目标：stabilize release/);
  f = await runSlashCommand(stdin, lastFrame, '/goal 请你帮我拉一下https://github.com/copyleft/slark.git');
  assert.equal((await agent.getGoal('cli'))?.objective, '请你帮我拉一下https://github.com/copyleft/slark.git');
  assert.doesNotMatch(strip(f), /Unknown goal command/);
  cleanup();
});

test('/compact is visible and handled by the TUI', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/compact');
  assert.match(strip(f), /No compaction needed\./, '/compact should call compactSession');
  assert.doesNotMatch(strip(f), /Unknown command: \/compact/);
  cleanup();
});

test('/subagents is visible and handled by the TUI', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/subagents');
  assert.match(strip(f), /No background sub-agents in this session\./, '/subagents should show a clear empty state');
  assert.doesNotMatch(strip(f), /Unknown command: \/subagents/);
  cleanup();
});

test('/attach adds an image for the next prompt without leaving the slash command in the editor', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  const f = await runSlashCommand(stdin, lastFrame, '/attach assets/moss-tui-demo.gif');
  const afterAttach = strip(f);
  assert.match(afterAttach, /Pending attachments \(1\)/, '/attach should add a pending attachment');
  assert.match(afterAttach, /\[Image #1\] assets\/moss-tui-demo\.gif/, 'pending image should be visible');
  assert.doesNotMatch(inputLine(lastFrame()), /\/attach/, '/attach command should not remain in the prompt editor');
  assert.match(inputLine(lastFrame()), /\[Image #1\]/, 'attachment ref should be deletable in the prompt editor');

  stdin.write('please inspect the attached image');
  await wait();
  stdin.write('\r');
  await wait(180);
  const sent = strip(lastFrame());
  assert.match(sent, /please inspect the attached image/, 'the next ordinary prompt should be submitted');
  assert.match(sent, /Pending attachments \(1\)/, 'submitted user prompt should include the attachment summary');
  assert.match(sent, /\[Image #1\] assets\/moss-tui-demo\.gif/, 'submitted prompt should carry the pending image');
  cleanup();
});

test('pasting a standalone file path and pressing Enter attaches it for the next prompt', async () => {
  setRows(24);
  const sentPrompts = [];
  const agent = makeAgent({ onStreamChat: (call) => sentPrompts.push(call) });
  const { stdin, lastFrame } = mount(agent);
  await wait(140);

  stdin.write('assets/moss-tui-demo.gif');
  await wait();
  stdin.write('\r');
  await wait(180);

  const afterPastePath = strip(lastFrame());
  assert.match(afterPastePath, /Pending attachments \(1\)/, 'pasted file path should become a pending attachment');
  assert.match(afterPastePath, /\[Image #1\] assets\/moss-tui-demo\.gif/, 'pending image should be visible');
  assert.doesNotMatch(afterPastePath, /assets\/moss-tui-demo\.gif\s+deepseek-v4-pro/, 'path should not be sent as a chat prompt');
  assert.match(inputLine(lastFrame()), /assets\/moss-tui-demo\.gif.*\[Image #1\]/, 'pasted path should stay editable with a removable attachment token');

  stdin.write('please inspect the pasted image');
  await wait();
  stdin.write('\r');
  await wait(180);

  const sent = strip(lastFrame());
  assert.match(sent, /please inspect the pasted image/, 'the next ordinary prompt should be submitted');
  assert.match(sent, /Pending attachments \(1\)/, 'submitted user prompt should include the attachment summary');
  assert.match(sent, /\[Image #1\] assets\/moss-tui-demo\.gif/, 'submitted prompt should carry the pasted image');
  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0].options.attachments.length, 2, 'image prompt should include text marker + image block');
  cleanup();
});

test('image attachments warn when the active provider cannot receive image content', async () => {
  setRows(24);
  const sentPrompts = [];
  const agent = makeAgent({ onStreamChat: (call) => sentPrompts.push(call) });
  const { stdin, lastFrame } = mount(agent, {
    ...runtime,
    config: { imageInput: false },
  });
  await wait(140);

  stdin.write('assets/moss-tui-demo.gif');
  await wait();
  stdin.write('\r');
  await wait(180);
  assert.match(strip(lastFrame()), /Image input is disabled/, 'pending image should disclose that vision input is disabled');

  stdin.write('please inspect the pasted image');
  await wait();
  stdin.write('\r');
  await wait(180);
  const sent = strip(lastFrame());
  assert.match(sent, /Image input is disabled/, 'submitted image prompt should keep the disabled-vision notice visible');
  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0].options.attachments.length, 2);
  cleanup();
});

test('deleting an inline attachment token removes it from the submitted prompt', async () => {
  setRows(24);
  const sentPrompts = [];
  const agent = makeAgent({ onStreamChat: (call) => sentPrompts.push(call) });
  const { stdin, lastFrame } = mount(agent);
  await wait(140);

  stdin.write('assets/moss-tui-demo.gif');
  await wait();
  stdin.write('\r');
  await wait(180);
  assert.match(inputLine(lastFrame()), /assets\/moss-tui-demo\.gif.*\[Image #1\]/);

  for (let i = 0; i < '[Image #1] '.length; i += 1) {
    stdin.write('\b');
    await wait(20);
  }
  const afterDelete = inputLine(lastFrame());
  assert.match(afterDelete, /assets\/moss-tui-demo\.gif/);
  assert.doesNotMatch(afterDelete, /\[Image #1\]/);

  stdin.write('\r');
  await wait(180);
  assert.equal(sentPrompts.length, 1);
  assert.equal(sentPrompts[0].message, 'assets/moss-tui-demo.gif');
  assert.equal(sentPrompts[0].options.attachments, undefined, 'deleted inline token should remove the pending attachment');
  cleanup();
});

test('Esc clears an accidental pending attachment while idle', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);

  stdin.write('assets/moss-tui-demo.gif');
  await wait();
  stdin.write('\r');
  await wait(180);
  assert.match(strip(lastFrame()), /Pending attachments \(1\)/);

  stdin.write(ESC);
  await wait(180);
  const afterEsc = strip(lastFrame());
  assert.match(afterEsc, /Cleared 1 pending attachment\./);
  assert.doesNotMatch(afterEsc.slice(afterEsc.lastIndexOf('Cleared 1 pending attachment.')), /Pending attachments \(1\)/);
  cleanup();
});

test('/model opens a selectable model list and accepts a number', async () => {
  setRows(24);
  let mounted = mount();
  let { stdin, lastFrame } = mounted;
  await wait(140);
  let f = await runSlashCommand(stdin, lastFrame, '/model');
  assert.match(strip(f), /Choose for this session:/, '/model should show a selector, not only echo the current model');
  assert.match(strip(f), /\/model <number>/, '/model selector should document numeric selection');
  stdin.write(DOWN);
  await wait();
  stdin.write('\r');
  await wait(180);
  assert.match(strip(lastFrame()), /Model switched to gpt-4o-mini/, 'Down + Enter should choose the highlighted model');
  cleanup();

  mounted = mount();
  ({ stdin, lastFrame } = mounted);
  await wait(140);
  f = await runSlashCommand(stdin, lastFrame, '/model 2');
  assert.match(strip(f), /Model switched to gpt-4o-mini/, '/model 2 should switch to the second listed model');
  assert.doesNotMatch(strip(f), /Unknown command: \/model/);
  cleanup();
});

test('running several commands in a row never garbles, and all output is retained in scrollback', async () => {
  setRows(24);
  const { stdin, lastFrame } = mount();
  await wait(140);
  for (const cmd of ['/status --verbose', '/permissions', '/tools']) {
    const f = await runSlashCommand(stdin, lastFrame, cmd);
    assertNoCrush(f, `after ${cmd}`);
  }
  // Every command's output stays in the committed <Static> history (terminal
  // scrollback), so the earliest command is still present after later ones ran — it is
  // never truncated or overwritten in place the way a fixed redraw frame would.
  const s = strip(lastFrame());
  assert.match(s, /\bStatus\b/, 'the first command (/status --verbose) output must still be present');
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
