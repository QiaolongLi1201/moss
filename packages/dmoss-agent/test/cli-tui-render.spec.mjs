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
} from '../dist/cli/tui.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ───── StatusBar ─────

test('SessionHeader renders a compact Codex-style launch panel', () => {
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
  assert.match(frame, />_ D-Moss/);
  assert.match(frame, /model:/);
  assert.match(frame, /deepseek-v4-pro/);
  assert.match(frame, /directory:/);
  assert.match(frame, /\/model to change/);
  assert.match(frame, /profile autonomous/);
  assert.match(frame, /cache stable/);
  cleanup();
});

test('SessionHeader surfaces disabled prompt cache mode', () => {
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
  assert.match(frame, /cache off/);
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

test('WelcomePanel renders a Tip and Codex-style command list', () => {
  const { lastFrame } = render(
    React.createElement(WelcomePanel, {
      workspace: '/Users/me/project',
      device: 'no device',
      model: 'deepseek-v4-pro',
      profile: 'cautious',
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /Tip:/);
  assert.match(frame, /\/model\s+choose what model to use/);
  assert.match(frame, /\/permissions\s+show safety/);
  assert.match(frame, /\/status\s+inspect runtime/);
  assert.match(frame, /Ctrl\+O\s+expand or collapse tool calls/);
  assert.match(frame, /profile cautious/);
  assert.match(frame, /cache stable/);
  cleanup();
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

test('ActivityItemLine renders a failed tool with the failed glyph', () => {
  const { lastFrame } = render(
    React.createElement(ActivityItemLine, {
      item: {
        id: '3',
        toolName: 'http_get',
        toolCallId: '3',
        startedAt: 0,
        status: 'failed',
        elapsedMs: 32,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /http_get/);
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
        elapsedMs: 12,
      },
    }),
  );
  const frame = lastFrame();
  assert.match(frame, /list_directory/);
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
  assert.match(frame, /\/model\s+choose what model to use/);
  assert.match(frame, /\/permissions\s+show safety/);
  assert.match(frame, /\/tools\s+list available tools/);
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
  assert.match(frame, /> ab▌cd/);
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
  assert.match(frame, /\/queue clear/);
  assert.match(frame, /next .*prompt .*waiting 9s .*1 line .*19 chars .*first queued prompt/);
  assert.match(frame, /#2 .*waiting 5s .*second queued prompt/);
  assert.match(frame, /\.\.\. 1 more queued prompt/);
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
