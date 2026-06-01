#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  commandSuggestion,
  editorPreviewLines,
  extractAttachmentRefs,
  footerHint,
  formatAttachmentChip,
  isLocalShellLine,
  promptPlaceholder,
  runLocalShellCommand,
  sanitizeRenderableText,
  statusBadge,
  statusLine,
  visibleText,
} from '../dist/cli/tui.js';

{
  const rendered = sanitizeRenderableText('\x1b[31mred\x1b[0m\x00\nok');
  assert.equal(rendered, 'red\nok');
}

{
  const rendered = sanitizeRenderableText(`${'\uFFFD'.repeat(20)}xxxx`);
  assert.equal(rendered, '[binary data omitted]');
}

{
  const token = 'a'.repeat(40);
  const rendered = sanitizeRenderableText(token);
  assert.notEqual(rendered, token);
  assert(rendered.includes(' '));
}

{
  const url = 'https://example.com/' + 'a'.repeat(40);
  assert.equal(sanitizeRenderableText(url), url);
}

{
  const link = '[developer.d-robotics.cc](https://developer.d-robotics.cc)';
  assert.equal(sanitizeRenderableText(link), link);
}

{
  const text = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join('\n');
  assert.equal(visibleText(text), text);
  assert.equal(
    visibleText(text, 3),
    ['... 15 earlier lines hidden ...', 'line 16', 'line 17', 'line 18'].join('\n'),
  );
}

assert.equal(isLocalShellLine('!pwd'), true);
assert.equal(isLocalShellLine('!'), false);
assert.equal(isLocalShellLine('  !pwd'), false);

assert.equal(commandSuggestion('/staus'), '/status');
assert.equal(commandSuggestion('/tool'), '/tools');
assert.equal(commandSuggestion('status'), null);

assert.match(promptPlaceholder('ready'), /message/);
assert.match(promptPlaceholder('running'), /running/);
assert.match(promptPlaceholder('approval'), /approval/);
assert.equal(statusBadge('ready'), 'ready');
assert.equal(statusBadge('running'), 'running');
assert.equal(statusBadge('approval'), 'approval needed');
assert.match(footerHint('ready'), /Shift\+Enter newline/);
assert.match(footerHint('running'), /\/stop cancel/);

{
  const line = statusLine({
    state: 'ready',
    model: 'user-configured-model',
    device: 'root@192.168.1.10',
    workspace: process.cwd(),
  });
  assert.match(line, /D-Moss  ready  user-configured-model/);
  assert.match(line, /cache stable/);
}

{
  const refs = extractAttachmentRefs('please inspect [Image #1] and [File #2], then compare [Image #1]');
  assert.deepEqual(refs, [
    { index: 1, kind: 'image', label: 'Image #1' },
    { index: 2, kind: 'file', label: 'File #2' },
  ]);
  assert.equal(formatAttachmentChip(refs[0]), '[Image #1] image');
}

{
  assert.deepEqual(editorPreviewLines('', 'message'), ['message']);
  assert.deepEqual(editorPreviewLines('a\nb\nc', 'message', 2), ['... 1 earlier input lines ...', 'b', 'c']);
}

{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runLocalShellCommand({ command: 'echo should-not-run', cwd: process.cwd(), signal: controller.signal }),
    /aborted before start/,
  );
}

{
  let streamed = '';
  const result = await runLocalShellCommand({
    command: 'printf tui-ok',
    cwd: process.cwd(),
    onChunk: (chunk) => {
      streamed += chunk;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.output, 'tui-ok');
  assert.equal(streamed, 'tui-ok');
}

{
  const result = await runLocalShellCommand({
    command: "node -e 'process.stdout.write((process.env.DMOSS_TUI_LOCAL_SHELL || \"\") + \":\" + (process.env.OPENCLAW_SHELL || \"\"))'",
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '1:');
}

console.log('[PASS] CLI TUI sanitizes output and controls local shell execution');
