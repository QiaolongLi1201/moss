#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui-render.spec.mjs
 */
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import {
  StatusBar,
  SessionHeader,
  WelcomePanel,
  ActivityItemLine,
  ApprovalPromptLine,
  TranscriptMessage,
  PromptEditor,
  QueuePreview,
  renderMarkdown,
  boardSurfaceLabel,
  boardTip,
  executionPlaneSummary,
  inferExecutionMode,
} from '../dist/cli/tui.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ───── StatusBar ─────

test('SessionHeader renders a compact Claude Code-style launch panel', () => {
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
  assert.match(frame, /✻ D-Moss Code/);
  assert.match(frame, /model\s+deepseek-v4-pro/);
  assert.match(frame, /deepseek-v4-pro/);
  assert.match(frame, /directory\s+[^\n]*project/);
  assert.match(frame, /\/model to change/);
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
  assert.match(frame, /D-Moss Code/);
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

test('WelcomePanel renders a compact Claude Code-style tip', () => {
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
      tip: 'Connect an RDK board to move from repo-only help to hardware verification.',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Moss Runtime/);
  assert.match(frame, /Running on\s+darwin\/arm64 host/);
  assert.match(frame, /Mode\s+PC Host Agent/);
  assert.match(frame, /Target\s+no board target/);
  assert.match(frame, /Inference\s+cloud routed \(qwen\)/);
  assert.match(frame, /Permissions\s+diagnose allowed, repair requires approval/);
  assert.match(frame, /Policy\s+workspace\/runtime fs/);
  assert.match(frame, /process\/service changes require approval/);
  assert.match(frame, /lifecycle install\/upgrade\/recover\/uninstall requires evidence/);
  assert.match(frame, /Device\s+no live board context/);
  assert.match(frame, /Connect a board to unlock/);
  assert.match(frame, /Diagnose Board/);
  assert.match(frame, /Deploy Model/);
  assert.match(frame, /Bring up Sensor/);
  assert.match(frame, /Debug ROS\/tros/);
  assert.match(frame, /Moss is device-centric/);
  assert.match(frame, /device state/);
  assert.match(frame, /benchmark output/);
  assert.match(frame, /Tip:/);
  assert.match(frame, /hardware verification/);
  assert.doesNotMatch(frame, /\/model\s+switch the model/);
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
  assert.match(frame, /remote board root@192\.168\.1\.10/);
  assert.match(frame, /device workflows unlocked/);
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
      tip: 'Connect an RDK board for hardware verification.',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Moss Runtime/);
  assert.match(frame, /PC Host Agent/);
  assert.match(frame, /no board target/);
  assert.match(frame, /cloud routed \(openai\)/);
  assert.match(frame, /Tip:/);
  assert.match(frame, /hardware verification/);
  assert.doesNotMatch(frame, /Diagnose Board/);
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

// ───── ApprovalPromptLine ─────

test('ApprovalPromptLine renders the question and y/n hint', () => {
  const { lastFrame } = render(
    React.createElement(ApprovalPromptLine, {
      question: 'Allow running this tool?\nIt will read 3 files.',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Allow running this tool/);
  assert.match(frame, /y approve/);
  assert.match(frame, /a always this session/);
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

test('PromptEditor renders a Codex-style placeholder at the prompt', () => {
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
  assert.match(frame, /›\s*$/);
  assert.doesNotMatch(frame, /› ▌/);
  cleanup();
});

test('PromptEditor renders the active key hint above the prompt', () => {
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
  assert(frame.indexOf('Tab complete') < frame.lastIndexOf('›'));
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
  assert.match(frame, /› \//);
  assert.match(frame, /type to filter/);
  assert.match(frame, /Tab complete/);
  assert.match(frame, /\/model\s+switch model/);
  assert.match(frame, /\/permissions\s+safety and approvals/);
  assert.match(frame, /\/tools\s+tool surface/);
  assert.match(frame, /\/sessions\s+recent sessions/);
  assert.match(frame, /\.\.\.\s+\d+ more commands/);
  assert(frame.split('\n').length <= 10);
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
      value: '/que',
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
  assert.equal(nextValue, '/queue');
  assert.equal(nextCursor, 6);
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
  assert.match(frame, /› ab▌cd/);
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
  assert.match(frame, /› abcd\s*$/);
  assert.doesNotMatch(frame, /abcd▌/);
  cleanup();
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
