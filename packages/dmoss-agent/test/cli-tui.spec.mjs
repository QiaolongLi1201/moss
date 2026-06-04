#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-tui.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPromptEdit,
  approvalKeyDecision,
  completeSlashCommandInput,
  commandSuggestion,
  dropLastQueuedInput,
  editorPreviewLines,
  extractAttachmentRefs,
  footerHint,
  formatQueueWait,
  formatAttachmentChip,
  formatTuiSessions,
  isQueueControlCommand,
  isLocalShellLine,
  promptCacheModeLabel,
  promptEditorRowBudget,
  promptPlaceholder,
  queueItemMeta,
  queueResumedMessage,
  renderSkills,
  runLocalShellCommand,
  sanitizeRenderableText,
  shouldDrainQueue,
  statusBadge,
  statusLine,
  stopRequestedMessage,
  transcriptViewportRows,
  visibleText,
} from '../dist/cli/tui.js';

function nodeCommand(source) {
  return `"${process.execPath}" -e ${JSON.stringify(source)}`;
}

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
assert.equal(commandSuggestion('/queu'), '/queue');
assert.equal(commandSuggestion('/queue dr'), '/queue drop');
assert.equal(commandSuggestion('/queue res'), '/queue resume');
assert.equal(commandSuggestion('/sess'), '/sessions');
assert.equal(commandSuggestion('status'), null);

assert.deepEqual(
  completeSlashCommandInput('/que', 4),
  { value: '/queue', cursor: 6 },
);
assert.deepEqual(
  completeSlashCommandInput('/mo', 3),
  { value: '/model', cursor: 6 },
);
assert.deepEqual(
  completeSlashCommandInput('/model deepseek', 6),
  null,
);
assert.deepEqual(
  completeSlashCommandInput('plain', 5),
  null,
);

assert.equal(promptPlaceholder('ready'), 'Ask Moss for code, board, or ROS help');
assert.match(promptPlaceholder('running'), /running/);
assert.match(promptPlaceholder('approval'), /approval/);
assert.match(promptPlaceholder('approval'), /y, a, n/);
assert.equal(statusBadge('ready'), 'ready');
assert.equal(statusBadge('running'), 'running');
assert.equal(statusBadge('approval'), 'approval needed');
assert.equal(approvalKeyDecision('y', {}), 'allow-once');
assert.equal(approvalKeyDecision('a', {}), 'allow-always');
assert.equal(approvalKeyDecision('n', {}), 'deny');
assert.equal(approvalKeyDecision('', { escape: true }), 'deny');
assert.equal(approvalKeyDecision('x', {}), null);
assert.match(footerHint('ready'), /Ctrl\+O tools/);
assert.match(footerHint('approval'), /a always this session/);
assert.match(footerHint('running'), /Esc cancel/);
assert.match(footerHint('running'), /Enter queue/);
assert.equal(promptEditorRowBudget('', { hint: 'Ctrl+O tools', model: 'deepseek-v4-pro' }), 2);
// '/' previews the full command dropdown; this budget tracks its row count — update when commands are added/removed.
assert.equal(promptEditorRowBudget('/'), 20);
assert.equal(promptEditorRowBudget('/que'), 4);
assert.equal(promptEditorRowBudget('/staus'), 3);
assert.equal(promptEditorRowBudget(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n')), 9);

assert.equal(formatQueueWait(undefined, 10_000), null);
assert.equal(formatQueueWait(9_750, 10_000), '<1s');
assert.equal(formatQueueWait(5_000, 10_000), '5s');
assert.equal(formatQueueWait(60_000, 180_000), '2m');
assert.match(queueItemMeta({ raw: 'plain prompt', message: 'plain prompt', enqueuedAt: 5_000 }, 10_000), /prompt .*waiting 5s .*1 line .*12 chars/);
assert.match(queueItemMeta({ raw: '/tools', message: '/tools' }, 10_000), /command .*1 line .*6 chars/);
assert.match(queueItemMeta({ raw: '!pwd', message: '!pwd' }, 10_000), /local shell .*1 line .*4 chars/);
{
  const first = { raw: 'first', message: 'first', enqueuedAt: 1 };
  const second = { raw: 'second', message: 'second', enqueuedAt: 2 };
  assert.deepEqual(dropLastQueuedInput([]), { next: [] });
  assert.deepEqual(dropLastQueuedInput([first, second]), { next: [first], dropped: second });
}
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: false, queueLength: 1 }), true);
assert.equal(shouldDrainQueue({ busy: true, approvalActive: false, pausedAfterCancel: false, queueLength: 1 }), false);
assert.equal(shouldDrainQueue({ busy: false, approvalActive: true, pausedAfterCancel: false, queueLength: 1 }), false);
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: true, queueLength: 1 }), false);
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: true, queueLength: 0 }), false);
assert.equal(shouldDrainQueue({ busy: false, approvalActive: false, pausedAfterCancel: false, queueLength: 0 }), false);
assert.equal(stopRequestedMessage(0), 'Stop requested for the current run.');
assert.equal(stopRequestedMessage(1), 'Stop requested. Queue paused (1 item); use /queue resume or send a new prompt to continue.');
assert.equal(stopRequestedMessage(2), 'Stop requested. Queue paused (2 items); use /queue resume or send a new prompt to continue.');
assert.equal(stopRequestedMessage(10), 'Stop requested. Queue paused (10 items); use /queue resume or send a new prompt to continue.');
assert.equal(queueResumedMessage(0), 'Queue resumed.');
assert.equal(queueResumedMessage(1), 'Queue resumed (1 item waiting).');
assert.equal(queueResumedMessage(3), 'Queue resumed (3 items waiting).');
assert.equal(isQueueControlCommand('/queue'), true);
assert.equal(isQueueControlCommand('/queue resume'), true);
assert.equal(isQueueControlCommand('/queue continue'), true);
assert.equal(isQueueControlCommand('/queue clear'), true);
assert.equal(isQueueControlCommand('/status'), false);
assert.equal(isQueueControlCommand('plain prompt'), false);
assert.equal(transcriptViewportRows({
  transcriptLength: 0,
  terminalRows: 57,
  headerRows: 6,
  promptRows: 3,
  queueRows: 0,
  footerRows: 0,
  approvalRows: 0,
  noticeRows: 0,
}), undefined);
assert.equal(transcriptViewportRows({
  transcriptLength: 2,
  terminalRows: 57,
  headerRows: 6,
  promptRows: 3,
  queueRows: 0,
  footerRows: 0,
  approvalRows: 0,
  noticeRows: 0,
}), 46);
{
  const emptyRows = transcriptViewportRows({
    transcriptLength: 0,
    terminalRows: 40,
    headerRows: 6,
    promptRows: 3,
    queueRows: 0,
    footerRows: 0,
    approvalRows: 0,
    noticeRows: 0,
  });
  const filledRows = transcriptViewportRows({
    transcriptLength: 1,
    terminalRows: 40,
    headerRows: 6,
    promptRows: 3,
    queueRows: 0,
    footerRows: 0,
    approvalRows: 0,
    noticeRows: 0,
  });
  assert.equal(emptyRows, undefined);
  assert.equal(filledRows, 29);
}
{
  const withoutChrome = transcriptViewportRows({
    transcriptLength: 1,
    terminalRows: 40,
    headerRows: 6,
    promptRows: 3,
    queueRows: 0,
    footerRows: 0,
    approvalRows: 0,
    noticeRows: 0,
  });
  const withChrome = transcriptViewportRows({
    transcriptLength: 1,
    terminalRows: 40,
    headerRows: 6,
    promptRows: 3,
    queueRows: 0,
    footerRows: 0,
    approvalRows: 4,
    noticeRows: 2,
  });
  assert.equal((withoutChrome ?? 0) - (withChrome ?? 0), 6);
}
assert.equal(transcriptViewportRows({
  transcriptLength: 1,
  terminalRows: 12,
  headerRows: 6,
  promptRows: 6,
  queueRows: 5,
  footerRows: 0,
  approvalRows: 10,
  noticeRows: 1,
}), 1);
{
  const rendered = formatTuiSessions([
    { sessionKey: 'older', createdAt: 0, updatedAt: 1_000, messageCount: 1 },
    { sessionKey: 'current', createdAt: 0, updatedAt: 3_000, messageCount: 2 },
    { sessionKey: 'newest', createdAt: 0, updatedAt: 5_000, messageCount: 3 },
  ], 'current', { limit: 2 });
  assert.match(rendered, /Sessions/);
  assert.match(rendered, /current: current/);
  assert.match(rendered, /recent \(2 of 3\)/);
  assert.match(rendered, /\* current · 2 messages/);
  assert.match(rendered, /newest · 3 messages/);
  assert.doesNotMatch(rendered, /older/);
  assert.match(rendered, /dmoss resume --last/);
  assert.match(rendered, /dmoss fork --fork-from <key>/);
}
{
  const rendered = formatTuiSessions([], 'cli');
  assert.match(rendered, /current: cli/);
  assert.match(rendered, /No saved sessions found yet/);
}

{
  const line = statusLine({
    state: 'ready',
    model: 'user-configured-model',
    device: 'root@192.168.1.10',
    workspace: process.cwd(),
    profile: 'autonomous',
  });
  assert.match(line, /D-Moss  ready  user-configured-model/);
  assert.match(line, /profile autonomous/);
  assert.match(line, /cache stable/);
  assert.match(statusLine({
    state: 'ready',
    model: 'user-configured-model',
    device: 'no device',
    workspace: process.cwd(),
    cacheMode: 'cache off',
  }), /cache off/);
  assert.equal(promptCacheModeLabel(), 'cache stable');
  assert.equal(promptCacheModeLabel({ config: { promptCacheEnabled: false } }), 'cache off');
  assert.equal(promptCacheModeLabel({ config: { promptCacheEnabled: true, promptCacheDebug: true } }), 'cache debug');
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-tui-skills-'));
  try {
    const availableDir = path.join(workspace, 'skills', 'rdk-camera');
    const learnedDir = path.join(workspace, 'skills', 'learned');
    fs.mkdirSync(availableDir, { recursive: true });
    fs.mkdirSync(learnedDir, { recursive: true });
    fs.writeFileSync(path.join(availableDir, 'SKILL.md'), [
      '---',
      'name: rdk-camera',
      'description: Diagnose RDK camera pipelines.',
      'tags: rdk,camera',
      'risk: low',
      'enabled: false',
      '---',
      '',
      '# RDK Camera',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(learnedDir, 'recover-usb.md'), '# Recover USB\n');
    const rendered = renderSkills(workspace);
    assert.match(rendered, /Skills: 1 available, 1 learned/);
    assert.match(rendered, /Available SKILL\.md entries:/);
    assert.match(rendered, /rdk-camera · low · disabled · rdk, camera .*Diagnose RDK camera pipelines/);
    assert.match(rendered, /Learned skills:/);
    assert.match(rendered, /recover-usb\.md/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

{
  assert.deepEqual(editorPreviewLines('', 'message'), ['message']);
  assert.deepEqual(editorPreviewLines('a\nb\nc', 'message', 2), ['... 1 earlier input lines ...', 'b', 'c']);
}

{
  assert.deepEqual(
    applyPromptEdit({ value: 'abcd', cursor: 2 }, { type: 'insert', text: 'X' }),
    { value: 'abXcd', cursor: 3 },
  );
  assert.deepEqual(
    applyPromptEdit({ value: 'abcd', cursor: 2 }, { type: 'backspace' }),
    { value: 'acd', cursor: 1 },
  );
  assert.deepEqual(
    applyPromptEdit({ value: 'abcd', cursor: 2 }, { type: 'delete' }),
    { value: 'abd', cursor: 2 },
  );
  assert.deepEqual(
    applyPromptEdit({ value: 'alpha beta', cursor: 10 }, { type: 'deletePreviousWord' }),
    { value: 'alpha ', cursor: 6 },
  );
  assert.deepEqual(
    applyPromptEdit({ value: 'abcd', cursor: 2 }, { type: 'killBefore' }),
    { value: 'cd', cursor: 0 },
  );
  assert.deepEqual(
    applyPromptEdit({ value: 'abcd', cursor: 2 }, { type: 'killAfter' }),
    { value: 'ab', cursor: 2 },
  );
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
    command: nodeCommand("process.stdout.write('tui-ok')"),
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
    command: nodeCommand("process.stdout.write((process.env.DMOSS_TUI_LOCAL_SHELL || '') + ':' + (process.env.OPENCLAW_SHELL || ''))"),
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, '1:');
}

console.log('[PASS] CLI TUI sanitizes output and controls local shell execution');
