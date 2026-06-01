#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  commandSuggestion,
  isLocalShellLine,
  promptPlaceholder,
  runLocalShellCommand,
  sanitizeRenderableText,
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

assert.equal(isLocalShellLine('!pwd'), true);
assert.equal(isLocalShellLine('!'), false);
assert.equal(isLocalShellLine('  !pwd'), false);

assert.equal(commandSuggestion('/staus'), '/status');
assert.equal(commandSuggestion('/tool'), '/tools');
assert.equal(commandSuggestion('status'), null);

assert.match(promptPlaceholder('ready'), /ask D-Moss/);
assert.match(promptPlaceholder('running'), /running/);
assert.match(promptPlaceholder('approval'), /approval/);

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

console.log('[PASS] CLI TUI sanitizes output and controls local shell execution');
