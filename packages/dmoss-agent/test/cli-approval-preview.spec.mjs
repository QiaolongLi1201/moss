#!/usr/bin/env node
/**
 * Approval-card detail preview: the user must be able to decide at the prompt
 * without expanding anything.
 *  - edit_file/write_file/apply_patch approvals show the actual ± diff
 *  - device-mutation approvals show the board target and exact command
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-approval-preview.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApprovalDetailLines, diffLinesForApproval } from '../dist/cli/approval-detail.js';
import { renderCliApprovalPrompt, describeCliToolApproval } from '../dist/cli/approval.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-approval-preview-'));

// ── diffLinesForApproval basics ───────────────────────────────────
{
  const diff = diffLinesForApproval('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(diff, ['  … (1 unchanged line)', '- b', '+ B', '  … (1 unchanged line)']);
  console.log('  [PASS] line diff with collapsed context');
}

// ── edit_file shows ± lines ───────────────────────────────────────
{
  const lines = buildApprovalDetailLines('edit_file', 'local_write', {
    path: 'src/app.js',
    old_string: 'const x = 1;',
    new_string: 'const x = 2;',
  });
  assert.ok(lines.includes('- const x = 1;'), `expected removal line, got ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('+ const x = 2;'), 'expected addition line');
  console.log('  [PASS] edit_file approval shows ± preview');
}

// ── write_file: new file vs overwrite diff ────────────────────────
{
  const fresh = buildApprovalDetailLines('write_file', 'local_write', {
    path: 'notes.txt',
    content: 'hello\nworld',
  }, { workspaceDir: ws });
  assert.match(fresh[0], /new file: notes\.txt \(2 lines\)/);
  assert.ok(fresh.includes('+ hello'));

  fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello\nplanet\n');
  const overwrite = buildApprovalDetailLines('write_file', 'local_write', {
    path: 'notes.txt',
    content: 'hello\nworld\n',
  }, { workspaceDir: ws });
  assert.match(overwrite[0], /overwrite: notes\.txt/);
  assert.ok(overwrite.includes('- planet'), `expected old line, got ${JSON.stringify(overwrite)}`);
  assert.ok(overwrite.includes('+ world'), 'expected new line');
  console.log('  [PASS] write_file approval shows new-file and overwrite diffs');
}

// ── apply_patch shows the patch body ──────────────────────────────
{
  const lines = buildApprovalDetailLines('apply_patch', 'local_write', {
    patch: '*** Begin Patch\n*** Add File: a.txt\n+created\n*** End Patch',
  });
  assert.ok(lines.includes('+created'));
  assert.ok(!lines.some((l) => /Begin Patch/.test(l)), 'patch envelope should be stripped');
  console.log('  [PASS] apply_patch approval shows patch body');
}

// ── device mutation shows target + command ────────────────────────
{
  const lines = buildApprovalDetailLines('device_exec', 'device_mutation', {
    command: 'systemctl restart yolo',
    timeout_ms: 30000,
  }, { device: { host: '192.168.1.10', user: 'root', port: 22 } });
  assert.equal(lines[0], 'Device action plan:');
  assert.ok(lines.some((l) => /root@192\.168\.1\.10:22/.test(l)), 'must show board target');
  assert.ok(lines.some((l) => /systemctl restart yolo/.test(l)), 'must show exact command');
  console.log('  [PASS] device approval shows action plan with target');
}

// ── long preview is capped with a hint ────────────────────────────
{
  const lines = buildApprovalDetailLines('write_file', 'local_write', {
    path: 'big.txt',
    content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'),
  }, { workspaceDir: ws });
  assert.ok(lines.length <= 18, `capped at 18 lines, got ${lines.length}`);
  assert.match(lines[lines.length - 1], /more lines/);
  console.log('  [PASS] long previews are capped');
}

// ── end-to-end: rendered prompt embeds the diff ───────────────────
{
  const preview = describeCliToolApproval(
    {
      tool: { name: 'edit_file', metadata: { sideEffectClass: 'local_write' }, inputSchema: { type: 'object' }, execute: async () => '' },
      input: { path: 'a.js', old_string: 'foo()', new_string: 'bar()' },
    },
    'workspace-write',
    {},
    {},
  );
  const prompt = renderCliApprovalPrompt(preview, { path: 'a.js', old_string: 'foo()', new_string: 'bar()' }, { workspaceDir: ws });
  assert.match(prompt, /- foo\(\)/);
  assert.match(prompt, /\+ bar\(\)/);
  assert.match(prompt, /Scope: workspace file change/);
  console.log('  [PASS] rendered approval prompt embeds the diff');
}

fs.rmSync(ws, { recursive: true, force: true });
console.log('[PASS] approval-card detail preview');
