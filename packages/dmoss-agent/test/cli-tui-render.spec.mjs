#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui-render.spec.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import stringWidth from 'string-width';
import {
  StatusBar,
  SessionHeader,
  WelcomePanel,
  ActivityItemLine,
  ApprovalPromptLine,
  TranscriptMessage,
  PromptEditor,
  applyPromptEdit,
  QueuePreview,
  SubagentTaskPanel,
  renderMarkdown,
  boardSurfaceLabel,
  boardTip,
  executionPlaneSummary,
  inferExecutionMode,
} from '../dist/cli/tui.js';
import {
  resolveTerminalThemeMode,
  resolveThemeTokens,
} from '../dist/cli/theme/theme.js';

const require = createRequire(import.meta.url);
const inkEntry = require.resolve('ink');
const { default: CursorContext } = await import(
  pathToFileURL(path.join(path.dirname(inkEntry), 'components/CursorContext.js')).href,
);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function wait(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───── Theme ─────

test('resolveTerminalThemeMode honors explicit and terminal background hints', () => {
  assert.equal(resolveTerminalThemeMode({ DMOSS_TUI_THEME: 'light' }), 'light');
  assert.equal(resolveTerminalThemeMode({ DMOSS_THEME: 'dark' }), 'dark');
  assert.equal(resolveTerminalThemeMode({ COLORFGBG: '0;15' }), 'light');
  assert.equal(resolveTerminalThemeMode({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(resolveTerminalThemeMode({ ITERM_PROFILE: 'Light Background' }), 'light');
});

test('resolveThemeTokens gives light terminals readable muted chrome', () => {
  const tokens = resolveThemeTokens({ COLORFGBG: '0;15' });
  assert.equal(tokens.textMuted, '#4b5563');
  assert.equal(tokens.textDim, '#6b7280');
  assert.equal(tokens.promptBorder, '#767676');
  assert.equal(tokens.permission, '#5769f7');
});

// ───── StatusBar ─────

test('SessionHeader renders a compact compact agent-style launch panel', () => {
  const { lastFrame } = render(
    React.createElement(SessionHeader, {
      state: 'ready',
      device: 'no device',
      workspace: '/Users/me/project',
      model: 'deepseek-v4-pro',
      version: 'v0.3.7',
      toolsExpanded: false,
      profile: 'autonomous',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Moss/);
  assert.doesNotMatch(frame, /RDK Studio/);
  assert.match(frame, /model:\s+deepseek-v4-pro/);
  assert.match(frame, /deepseek-v4-pro/);
  assert.match(frame, /cwd:\s+[^\n]*project/);
  assert.doesNotMatch(frame, /profile autonomous/);
  assert.doesNotMatch(frame, /cache stable/);
  cleanup();
});

test('SessionHeader keeps cache policy out of the launch panel', () => {
  const { lastFrame } = render(
    React.createElement(SessionHeader, {
      state: 'ready',
      device: 'no device',
      workspace: '/Users/me/project',
      model: 'deepseek-v4-pro',
      version: 'v0.3.7',
      toolsExpanded: false,
      cacheMode: 'cache off',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Moss/);
  assert.doesNotMatch(frame, /cache off/);
  cleanup();
});

test('StatusBar renders the profile, device, workspace, state, and version', () => {
  const { lastFrame } = render(
    React.createElement(StatusBar, {
      state: 'ready',
      device: 'root@192.168.1.10',
      workspace: '/Users/me/project',
      version: 'v0.3.6',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Default/);
  assert.match(frame, /root@192\.168\.1\.10/);
  assert.match(frame, /ready/);
  assert.match(frame, /v0\.3\.6/);
  cleanup();
});

test('StatusBar shows "approval needed" badge in approval state', () => {
  const { lastFrame } = render(
    React.createElement(StatusBar, {
      state: 'approval',
      device: 'no device',
      workspace: '/tmp',
      version: 'v0.3.6',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /approval needed/);
  cleanup();
});

test('StatusBar renders a disconnected device gracefully', () => {
  const { lastFrame } = render(
    React.createElement(StatusBar, {
      state: 'ready',
      device: 'no device',
      workspace: '/tmp',
      version: 'v0.3.6',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /no device/);
  cleanup();
});

test('WelcomePanel renders a compact compact agent-style tip', () => {
  const { lastFrame } = render(
    React.createElement(WelcomePanel, {
      workspace: '/Users/me/project',
      device: 'no device',
      model: 'deepseek-v4-pro',
      profile: 'cautious',
      executionPlane: {
        mode: 'pc-host',
        runningOn: 'darwin/arm64 host',
        targetDevice: 'no board target',
        inference: 'cloud routed (qwen)',
        permissions: 'diagnose allowed, repair requires approval',
        policy: 'workspace/runtime fs  ·  process/service changes require approval  ·  network via approved tools  ·  lifecycle install/upgrade/recover/uninstall requires evidence',
        deviceContext: 'no live board context  ·  local workspace only',
        lockedCapabilities: 'Connect a board to unlock: device diagnosis, model deployment, sensor bring-up, ROS/tros debugging, log collection',
      },
      tip: 'Develop on this host now; connect an RDK board when you need hardware verification.',
    }),
  );
  const frame = lastFrame();
  // compact agent-style welcome: host development + optional board path. No
  // device-context block, no "Try:" line.
  assert.match(frame, /Tips for getting started/);
  assert.match(frame, /Host Code/);
  assert.match(frame, /Host Commands/);
  assert.match(frame, /Board Diagnostics/);
  assert.match(frame, /Board Workflows/);
  assert.match(frame, /Develop on this host now/);
  assert.match(frame, /hardware verification/);
  assert.doesNotMatch(frame, /Moss Runtime/);
  assert.doesNotMatch(frame, /Try:/);
  assert.doesNotMatch(frame, /Moss is device-centric/);
  assert.doesNotMatch(frame, /profile cautious/);
  cleanup();
});

test('WelcomePanel highlights a connected board surface without command clutter', () => {
  const { lastFrame } = render(
    React.createElement(WelcomePanel, {
      workspace: '/Users/me/project',
      device: 'root@192.168.1.10',
      executionPlane: {
        mode: 'pc-host',
        runningOn: 'darwin/arm64 host',
        targetDevice: 'remote board root@192.168.1.10',
        inference: 'cloud routed (qwen)',
        permissions: 'diagnose allowed, repair requires approval',
        policy: 'workspace/runtime fs  ·  process/service changes require approval  ·  network via approved tools  ·  lifecycle install/upgrade/recover/uninstall requires evidence',
        deviceContext: 'remote board 192.168.1.10:22  ·  device facts available after diagnose',
        lockedCapabilities: 'device workflows unlocked',
      },
      tip: 'PC Host Moss uses SSH/bridge tools for board diagnostics; ! stays on the host.',
    }),
  );
  const frame = lastFrame();
  // Welcome is compact agent-minimal now; the board surface surfaces via the tip,
  // not a device line.
  assert.match(frame, /Tips for getting started/);
  assert.match(frame, /Host Code/);
  assert.match(frame, /Board Diagnostics/);
  assert.match(frame, /SSH\/bridge tools/);
  assert.doesNotMatch(frame, /\/tools\s+show available tools/);
  cleanup();
});

test('WelcomePanel renders a compact short-terminal variant', () => {
  const { lastFrame } = render(
    React.createElement(WelcomePanel, {
      compact: true,
      workspace: '/Users/me/project',
      device: 'no device',
      executionPlane: {
        mode: 'pc-host',
        runningOn: 'darwin/arm64 host',
        targetDevice: 'no board target',
        inference: 'cloud routed (openai)',
        permissions: 'diagnose allowed, repair requires approval',
        policy: 'workspace/runtime fs',
        deviceContext: 'no live board context',
        lockedCapabilities: 'Connect a board to unlock: device diagnosis',
      },
      tip: 'Develop on this host now; connect an RDK board when you need hardware verification.',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /PC Host Agent/);
  assert.match(frame, /no board target/);
  assert.match(frame, /Tip:/);
  assert.match(frame, /Develop on this host/);
  assert.match(frame, /hardware verification/);
  assert.doesNotMatch(frame, /Moss Runtime/);
  assert.doesNotMatch(frame, /Try:/);
  assert.doesNotMatch(frame, /Host Code/);
  assert(frame.split('\n').length <= 4);
  cleanup();
});

test('board surface helpers distinguish SSH and local-board modes', () => {
  const previous = process.env.DMOSS_BOARD_RUNTIME;
  delete process.env.DMOSS_BOARD_RUNTIME;
  assert.equal(
    boardSurfaceLabel({ device: { host: '192.168.1.10', user: 'root', port: 22 } }),
    'remote board root@192.168.1.10',
  );
  assert.match(
    boardTip({ device: { host: '192.168.1.10', user: 'root', port: 22 } }),
    /SSH\/bridge tools/,
  );
  process.env.DMOSS_BOARD_RUNTIME = '1';
  assert.equal(inferExecutionMode(), 'on-board');
  assert.equal(boardSurfaceLabel(), 'current machine is the board');
  if (previous === undefined) delete process.env.DMOSS_BOARD_RUNTIME;
  else process.env.DMOSS_BOARD_RUNTIME = previous;
});

test('executionPlaneSummary models PC Host, On-board, and Hybrid modes', () => {
  const previousBoard = process.env.DMOSS_BOARD_RUNTIME;
  const previousHybrid = process.env.DMOSS_HYBRID_MODE;
  delete process.env.DMOSS_BOARD_RUNTIME;
  delete process.env.DMOSS_HYBRID_MODE;
  assert.equal(executionPlaneSummary({ config: { provider: 'qwen', safetyMode: 'workspace-write', approvalPolicy: 'prompt' } }).mode, 'pc-host');
  process.env.DMOSS_BOARD_RUNTIME = '1';
  const onboard = executionPlaneSummary({ config: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000', safetyMode: 'workspace-write', approvalPolicy: 'prompt' } });
  assert.equal(onboard.mode, 'on-board');
  assert.match(onboard.targetDevice, /current machine is the board/);
  assert.match(onboard.inference, /local board inference/);
  process.env.DMOSS_HYBRID_MODE = '1';
  const hybrid = executionPlaneSummary({
    meshEnabled: true,
    device: { host: '192.168.1.10', user: 'root' },
    config: { provider: 'qwen', safetyMode: 'workspace-write', approvalPolicy: 'prompt' },
  });
  assert.equal(hybrid.mode, 'hybrid');
  assert.match(hybrid.targetDevice, /host -> board Moss root@192\.168\.1\.10/);
  if (previousBoard === undefined) delete process.env.DMOSS_BOARD_RUNTIME;
  else process.env.DMOSS_BOARD_RUNTIME = previousBoard;
  if (previousHybrid === undefined) delete process.env.DMOSS_HYBRID_MODE;
  else process.env.DMOSS_HYBRID_MODE = previousHybrid;
});

// ───── ActivityItemLine ─────

test('ActivityItemLine renders a running tool with the running glyph', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: '1',
        toolName: 'read_file',
        toolCallId: '1',
        startedAt: 0,
        status: 'running',
        inputSummary: '{"path": "README.md"}',
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /read_file/);
  assert.match(frame, /README\.md/);
  assert.match(frame, /…/);
  cleanup();
});

test('ActivityItemLine renders a completed tool with elapsed time', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: '2',
        toolName: 'exec',
        toolCallId: '2',
        startedAt: 0,
        status: 'ok',
        elapsedMs: 124,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /exec/);
  assert.match(frame, /124ms/);
  cleanup();
});

test('ActivityItemLine renders non-ok tool outcome before elapsed time', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: '2b',
        toolName: 'web_fetch',
        toolCallId: '2b',
        startedAt: 0,
        status: 'ok',
        outcome: 'suppressed',
        elapsedMs: 0,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /web_fetch/);
  assert.match(frame, /suppressed\s+·\s+0ms/);
  cleanup();
});

test('ActivityItemLine renders a failed tool with the failed glyph', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: '3',
        toolName: 'http_get',
        toolCallId: '3',
        startedAt: 0,
        status: 'failed',
        outcome: 'denied',
        elapsedMs: 32,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /http_get/);
  assert.match(frame, /denied\s+·\s+32ms/);
  assert.match(frame, /!/);
  cleanup();
});

test('ActivityItemLine renders expanded tool results under the response connector', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      expanded: true,
      item: {
        id: '4',
        toolName: 'list_directory',
        toolCallId: '4',
        startedAt: 0,
        status: 'ok',
        elapsedMs: 12,
        result: 'LICENSE\nREADME.md',
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /list_directory/);
  assert.match(frame, /[⎿L]/);
  assert.match(frame, /LICENSE/);
  assert.match(frame, /README\.md/);
  cleanup();
});

// ───── ApprovalPromptLine ─────

test('ApprovalPromptLine renders the question and selectable choices', () => {
  const { lastFrame } = render(
    React.createElement(ApprovalPromptLine, {
      question: [
        'Moss wants to run a local command',
        '  npm test',
        'Scope: workspace command',
      ].join('\n'),
      selectedIndex: 1,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Moss wants to run a local command/);
  assert.match(frame, /npm test/);
  assert.match(frame, /Scope: workspace command/);
  assert.doesNotMatch(frame, /side effect/);
  assert.doesNotMatch(frame, /policy:/);
  assert.match(frame, /1\. \[ \] Approve once/);
  assert.match(frame, /› 2\. \[x\] Always this workspace/);
  assert.match(frame, /Trust local operations in this workspace/);
  assert.match(frame, /3\. \[ \] Deny/);
  assert.match(frame, /Enter submit/);
  assert.match(frame, /←\/→ or ↑\/↓ choose/);
  assert.match(frame, /y approve/);
  assert.match(frame, /a trust scope/);
  assert.match(frame, /n.*Esc deny/);
  cleanup();
});

// ───── TranscriptMessage ─────

test('TranscriptMessage renders a system message dimmed', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: { id: 1, kind: 'system', text: 'Ready. Ask a task or use /examples.' },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Ready\. Ask a task/);
  cleanup();
});

test('TranscriptMessage renders a user message as plain text', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: { id: 2, kind: 'user', text: 'Read README' },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Read README/);
  cleanup();
});

test('TranscriptMessage renders an error message with the error text', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: { id: 3, kind: 'error', text: 'Tool denied.' },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Tool denied\./);
  cleanup();
});

test('TranscriptMessage renders a tool message via ActivityItemLine', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 4,
        kind: 'tool',
        text: '',
        toolName: 'list_directory',
        status: 'ok',
        outcome: 'replayed',
        elapsedMs: 12,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /list_directory/);
  assert.match(frame, /replayed\s+·\s+12ms/);
  assert.match(frame, /12ms/);
  cleanup();
});

test('TranscriptMessage renders attachment chips for image and file references', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 5,
        kind: 'assistant',
        text: 'please inspect [Image #1] and [File #2]',
        finalized: false,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /\[Image #1\] image/);
  assert.match(frame, /\[File #2\] file/);
  cleanup();
});

test('TranscriptMessage renders finalized assistant text as markdown', () => {
  const { lastFrame } = render(
    React.createElement(TranscriptMessage, {
      item: {
        id: 6,
        kind: 'assistant',
        text: '# Heading\n\n- item one\n- item two\n\n```bash\necho hi\n```\n',
        finalized: true,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Heading/);
  assert.match(frame, /item one/);
  assert.match(frame, /item two/);
  assert.match(frame, /echo hi/);
  cleanup();
});

// ───── PromptEditor ─────

test('PromptEditor renders a disabled state with a dim placeholder', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: 'some input',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: 'message, /examples, /status, or !pwd',
      disabled: true,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /some input/);
  cleanup();
});

test('PromptEditor renders a agent-style placeholder at the prompt', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: '',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: 'Ask Moss for code, board, or ROS help',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Ask Moss for code, board, or ROS help/);
  assert.match(frame, /> /);
  assert.doesNotMatch(frame, /▌/);
  cleanup();
});

test('PromptEditor renders the active key hint below the prompt', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: '',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: 'Ask Moss for code, board, or ROS help',
      disabled: false,
      hint: 'Ctrl+O tools · Tab complete · Up/Down history',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Ctrl\+O tools/);
  assert.match(frame, /Tab complete/);
  assert.match(frame, /Up\/Down history/);
  const lines = frame.split('\n');
  const placeholderLine = lines.find((line) => line.includes('Ask Moss for code'));
  const hintLine = lines.find((line) => line.includes('Ctrl+O tools'));
  assert.ok(placeholderLine);
  assert.ok(hintLine);
  assert.notEqual(placeholderLine, hintLine);
  // Hint now renders below the bordered input box (compact agent layout).
  assert(frame.indexOf('Ask Moss') < frame.indexOf('Tab complete'));
  cleanup();
});

test('PromptEditor renders a multi-line indicator when value has newlines', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: 'first line\nsecond line',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: 'message',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /2 lines/);
  cleanup();
});

test('PromptEditor renders command suggestions when slash is typed', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: '/',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /> \//);
  // Navigable, windowed menu (≤6 rows): the first page of commands is shown,
  // the selected (first) row highlighted and marked with a chevron. No static
  // "… N more / type to filter" row.
  assert.match(frame, /›\s+\/status\s+view model, workspace, device, and tool state/);
  assert.match(frame, /\/status\s+view model, workspace, device, and tool state/);
  assert.match(frame, /\/subagents\s+show background sub-agent status and progress/);
  assert.match(frame, /\/model\s+choose or switch the active model/);
  assert.match(frame, /\/goal\s+show or manage the persistent session goal/);
  assert.match(frame, /\/compact\s+compress older conversation history/);
  assert.match(frame, /\/connect\s+connect an RDK board/);
  assert.doesNotMatch(frame, /\/attach\s+attach an image or text file/);
  assert.doesNotMatch(frame, /\/sessions\s+list saved chats/);
  assert.doesNotMatch(frame, /\/context\s+show token usage/);
  assert.doesNotMatch(frame, /\/tools\s+tool surface/);
  assert.doesNotMatch(frame, /more commands/);
  assert(frame.split('\n').length <= 12);
  cleanup();
});

test('PromptEditor renders inline argument hints for slash commands', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: '/goal',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /\/goal\s+\[<condition> \| clear\]/);
  cleanup();
});

test('PromptEditor maps arrow keys to prompt history callbacks', async () => {
  let previousCount = 0;
  let nextCount = 0;
  const { stdin } = render(
    React.createElement(PromptEditor, {
      value: '',
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
      onHistoryPrevious: () => {
        previousCount += 1;
      },
      onHistoryNext: () => {
        nextCount += 1;
      },
    }),
  );
  stdin.write('\u001B[A');
  stdin.write('\u001B[B');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(previousCount, 1);
  assert.equal(nextCount, 1);
  cleanup();
});

test('PromptEditor inserts typed text at the current cursor', async () => {
  let nextValue = '';
  let nextCursor = -1;
  const { stdin } = render(
    React.createElement(PromptEditor, {
      value: 'abcd',
      cursor: 2,
      onChange: (value) => {
        nextValue = value;
      },
      onCursorChange: (cursor) => {
        nextCursor = cursor;
      },
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  stdin.write('X');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextValue, 'abXcd');
  assert.equal(nextCursor, 3);
  cleanup();
});

test('PromptEditor accepts slash command completion with Tab', async () => {
  let nextValue = '';
  let nextCursor = -1;
  const { stdin } = render(
    React.createElement(PromptEditor, {
      value: '/con',
      cursor: 4,
      onChange: (value) => {
        nextValue = value;
      },
      onCursorChange: (cursor) => {
        nextCursor = cursor;
      },
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  stdin.write('\t');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextValue, '/connect');
  assert.equal(nextCursor, 8);
  cleanup();
});

test('PromptEditor submits on a plain CR enter sequence', async () => {
  const submitted = [];
  const { stdin } = render(
    React.createElement(PromptEditor, {
      value: 'hello',
      onChange: (value) => {
        throw new Error(`plain enter should submit, not edit to ${JSON.stringify(value)}`);
      },
      onSubmit: (value) => {
        submitted.push(value);
      },
      placeholder: '',
      disabled: false,
    }),
  );
  stdin.write('\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(submitted, ['hello']);
  cleanup();
});

test('PromptEditor renders the cursor at the requested column', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: 'abcd',
      cursor: 2,
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  // Cursor is an inverse-video block (compact agent style) — color styling is
  // stripped in this no-TTY test env, so assert the text stays intact.
  assert.match(frame, /> abcd/);
  cleanup();
});

test('PromptEditor lets the terminal cursor anchor IME at the end of input', () => {
  const { lastFrame } = render(
    React.createElement(PromptEditor, {
      value: 'abcd',
      cursor: 4,
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  const frame = lastFrame();
  // Cursor at end-of-input renders no block, so the terminal cursor can anchor
  // there for IME composition (CJK input stays correct).
  assert.match(frame, /> abcd/);
  assert.doesNotMatch(frame, /\[7m/);
  cleanup();
});

test('PromptEditor cursor movement treats an emoji grapheme cluster as one stop', () => {
  const flag = '🇨🇳';
  const value = `a${flag}b`;
  const afterB = applyPromptEdit({ value, cursor: value.length }, { type: 'left' });
  assert.equal(afterB.cursor, `a${flag}`.length);

  const beforeFlag = applyPromptEdit({ value, cursor: afterB.cursor }, { type: 'left' });
  assert.equal(beforeFlag.cursor, 'a'.length);

  const removedFlag = applyPromptEdit({ value: `a${flag}`, cursor: `a${flag}`.length }, { type: 'backspace' });
  assert.equal(removedFlag.value, 'a');
  assert.equal(removedFlag.cursor, 'a'.length);
});

test('PromptEditor commits the current cursor position during the same render', async () => {
  const previousIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const committed = [];
  const makeEditor = (value, cursor) => React.createElement(
    CursorContext.Provider,
    {
      value: {
        setCursorPosition(position) {
          if (!position) {
            committed.push(position);
            return;
          }
          committed.push({ x: position.x, y: position.y });
        },
      },
    },
    React.createElement(PromptEditor, {
      value,
      cursor,
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: '',
      disabled: false,
    }),
  );
  const lastPosition = () => [...committed].reverse().find((position) => position && Number.isFinite(position.x));

  try {
    const { rerender } = render(makeEditor('a', 1));
    for (let i = 0; i < 10 && !lastPosition(); i += 1) await wait(10);
    const initial = lastPosition();
    assert.ok(initial, 'expected PromptEditor to commit an initial hardware cursor position');

    committed.length = 0;
    rerender(makeEditor('ab', 2));
    await wait();
    const afterTyping = lastPosition();
    assert.ok(afterTyping, 'expected PromptEditor to commit a cursor position after typing');
    assert.equal(afterTyping.x, initial.x + 1);
  } finally {
    cleanup();
    Object.defineProperty(process.stdout, 'isTTY', { value: previousIsTty, configurable: true });
  }
});

test('PromptEditor keeps long single-line text in sync with the terminal cursor', async () => {
  const previousIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const committed = [];
  const value = '我有一个问题是为什么当前的moss在某个文件夹启动后就会创建出那么多';

  try {
    const { lastFrame } = render(
      React.createElement(
        CursorContext.Provider,
        {
          value: {
            setCursorPosition(position) {
              if (position?.x !== undefined) committed.push({ x: position.x, y: position.y });
            },
          },
        },
        React.createElement(PromptEditor, {
          value,
          cursor: value.length,
          onChange: () => undefined,
          onSubmit: () => undefined,
          placeholder: '',
          disabled: false,
        }),
      ),
    );
    for (let i = 0; i < 10 && committed.length === 0; i += 1) await wait(10);
    const last = committed.at(-1);
    assert.ok(last, 'expected PromptEditor to commit a cursor position for long input');
    const promptLine = lastFrame().split('\n').find((line) => line.includes('> '));
    assert.ok(promptLine, 'expected prompt input line to render');
    assert.ok(promptLine.includes(value), 'long input should render without inserted wrapping spaces');
    assert.equal(last.x, stringWidth(promptLine.slice(0, promptLine.indexOf(value) + value.length)));
  } finally {
    cleanup();
    Object.defineProperty(process.stdout, 'isTTY', { value: previousIsTty, configurable: true });
  }
});

test('PromptEditor pans very long single-line input so the cursor stays visible', async () => {
  const previousIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const committed = [];
  const value = 'a'.repeat(140);

  try {
    render(
      React.createElement(
        CursorContext.Provider,
        {
          value: {
            setCursorPosition(position) {
              if (position?.x !== undefined) committed.push({ x: position.x, y: position.y });
            },
          },
        },
        React.createElement(PromptEditor, {
          value,
          cursor: value.length,
          onChange: () => undefined,
          onSubmit: () => undefined,
          placeholder: '',
          disabled: false,
        }),
      ),
    );
    for (let i = 0; i < 10 && committed.length === 0; i += 1) await wait(10);
    const last = committed.at(-1);
    assert.ok(last, 'expected PromptEditor to commit a cursor position for very long input');
    assert.ok(last.x < 100, `cursor x ${last.x} should stay inside the test terminal`);
  } finally {
    cleanup();
    Object.defineProperty(process.stdout, 'isTTY', { value: previousIsTty, configurable: true });
  }
});

test('QueuePreview renders queued prompts and overflow count', () => {
  const { lastFrame } = render(
    React.createElement(QueuePreview, {
      items: [
        { raw: 'first queued prompt', message: 'first queued prompt', enqueuedAt: 1_000 },
        { raw: 'second queued prompt', message: 'second queued prompt', enqueuedAt: 5_000 },
        { raw: 'third queued prompt', message: 'third queued prompt', enqueuedAt: 9_500 },
        { raw: 'fourth queued prompt', message: 'fourth queued prompt', enqueuedAt: 9_900 },
      ],
      now: 10_000,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /queued 4/);
  assert.match(frame, /next runs when current task finishes/);
  assert.match(frame, /\/queue drop last/);
  assert.match(frame, /\/queue clear all/);
  assert.match(frame, /next .*prompt .*waiting 9s .*1 line .*19 chars .*first queued prompt/);
  assert.match(frame, /#2 .*waiting 5s .*second queued prompt/);
  assert.match(frame, /\.\.\. 1 more queued prompt/);
  cleanup();
});

test('QueuePreview renders paused queue resume controls', () => {
  const { lastFrame } = render(
    React.createElement(QueuePreview, {
      paused: true,
      items: [
        { raw: 'first queued prompt', message: 'first queued prompt', enqueuedAt: 1_000 },
      ],
      now: 10_000,
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /queued 1/);
  assert.match(frame, /paused after stop/);
  assert.match(frame, /\/queue resume/);
  assert.match(frame, /send a prompt to resume/);
  assert.match(frame, /\/queue drop last/);
  cleanup();
});

test('SubagentTaskPanel renders live sub-agent progress and failed completions', () => {
  const now = 1_000;
  const { lastFrame } = render(
    React.createElement(SubagentTaskPanel, {
      now,
      tasks: [
        {
          taskId: 'parent/sub-live',
          kind: 'subagent',
          label: '调研：公司概况',
          status: 'running',
          createdAt: 0,
          updatedAt: 600,
          startedAt: 100,
          timeoutMs: 120_000,
          payload: { task: '调研 D-Robotics 公司概况', scope: 'explore', maxTurns: 5 },
          progress: {
            phase: 'tool',
            currentTurn: 2,
            maxTurns: 5,
            toolCalls: 4,
            lastTool: 'web_fetch',
          },
        },
        {
          taskId: 'parent/sub-fail',
          kind: 'subagent',
          label: '调研：产品线',
          status: 'failed',
          createdAt: 0,
          updatedAt: 900,
          startedAt: 100,
          completedAt: 900,
          payload: { task: '调研产品线', scope: 'explore' },
          error: 'API Error: socket closed',
        },
      ],
      completions: new Map([
        ['parent/sub-fail', {
          taskId: 'parent/sub-fail',
          status: 'failed',
          success: false,
          summary: 'Sub-agent failed: API Error: socket closed',
          error: 'API Error: socket closed',
          startedAt: 100,
          completedAt: 900,
          durationMs: 800,
        }],
      ]),
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Sub-agents/);
  assert.match(frame, /1 running/);
  assert.match(frame, /调研：公司概况/);
  assert.match(frame, /turn 2\/5/);
  assert.match(frame, /4 tools/);
  assert.match(frame, /last web_fetch/);
  assert.match(frame, /调研：产品线/);
  assert.match(frame, /API Error: socket closed/);
  cleanup();
});

// ───── renderMarkdown ─────

test('renderMarkdown produces a string with ANSI codes for code blocks', () => {
  const out = renderMarkdown('hello `inline` world');
  assert.match(out, /hello/);
  assert.match(out, /inline/);
  assert.match(out, /world/);
});

test('renderMarkdown handles headings', () => {
  const out = renderMarkdown('# Title\n\nbody');
  assert.match(out, /Title/);
  assert.match(out, /body/);
});

test('renderMarkdown keeps wide CJK markdown tables terminal-friendly', () => {
  const out = renderMarkdown(
    [
      '| 子包 | 职责 |',
      '| --- | --- |',
      '| packages/desktop | Electron 主进程 + preload + renderer (SPA)。用 electron-vite 构建，支持 Mac/Win/Linux 三平台打包 (electron-builder)。主进程里有 adapter/、api/、chat/、config/、platform/、update/ 等模块 |',
      '| packages/web-cli | CLI 入口，可以直接启动 WebUI |',
      '| packages/web-host | 零 Electron 依赖的 WebUI 托管层，启动后端进程 + 静态文件服务器 + 反向代理 API/WebSocket + bcrypt 鉴权 |',
      '| packages/shared-scripts | 共享脚本工具 |',
    ].join('\n'),
    { width: 80 },
  );
  assert.doesNotMatch(out, /[┌┬┐├┼┤└┴┘╔═╗╚╝]/);
  assert.match(out, /packages\/desktop\s+\| Electron 主进程/);
  assert.match(out, /adapter\/、 api\/、/);
  assert.match(out, /chat\/、 config\/、 platform\/、 update\//);
  assert.doesNotMatch(out, /conf ig/);
  for (const line of out.split('\n')) {
    assert.ok(stringWidth(line) <= 80, `expected <= 80 columns, got ${stringWidth(line)}: ${line}`);
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    process.stderr.write(`  ok  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stderr.write(`  FAIL ${name}\n`);
    process.stderr.write(`       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}\n`);
  }
}

if (failures > 0) {
  console.error(`[FAIL] ${failures} of ${tests.length} TUI render tests failed`);
  process.exit(1);
}
console.log(`[PASS] TUI render tests (${tests.length} snapshots)`);
