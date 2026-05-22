#!/usr/bin/env node
/**
 * Apply Patch core self-test: parser + update applier.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/apply-patch-core.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  applyUpdateHunk,
  extractAddContent,
  parsePatch,
} from '../dist/utils/index.js';

// 1. Parse: empty input → no error, no hunks
{
  const result = parsePatch('');
  assert.equal(result.hunks.length, 0);
  assert.equal(result.errors.length, 0, 'empty input is not an error');
}

// 2. Parse: missing Begin/End markers → error
{
  const result = parsePatch('+ added\n- removed');
  assert.equal(result.hunks.length, 0);
  assert.equal(result.errors.length, 1, 'malformed patch should report error');
}

// 3. Parse: Add File hunk
{
  const patch = [
    '*** Begin Patch',
    '*** Add File: foo/bar.ts',
    '+const x = 1;',
    '+const y = 2;',
    '*** End Patch',
  ].join('\n');
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].type, 'add');
  assert.equal(result.hunks[0].path, 'foo/bar.ts');
  assert.equal(extractAddContent(result.hunks[0]), 'const x = 1;\nconst y = 2;');
}

// 4. Parse: Delete File hunk
{
  const patch = [
    '*** Begin Patch',
    '*** Delete File: stale.log',
    '*** End Patch',
  ].join('\n');
  const result = parsePatch(patch);
  assert.equal(result.hunks.length, 1);
  assert.equal(result.hunks[0].type, 'delete');
  assert.equal(result.hunks[0].path, 'stale.log');
}

// 5. Update: context match + replace single line
{
  const before = ['line1', 'line2 old', 'line3'].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    ' line1',
    '-line2 old',
    '+line2 new',
    ' line3',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined);
  assert.equal(result, 'line1\nline2 new\nline3');
}

// 6. Update: insert lines (no removes)
{
  const before = ['function foo() {', '  return 1;', '}'].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    ' function foo() {',
    '+  // new comment',
    '   return 1;',
    ' }',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined);
  assert.match(result, /\/\/ new comment/);
}

// 7. Update: context mismatch returns error, does not corrupt original
{
  const before = 'unrelated content';
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    ' nonexistent_anchor',
    '-foo',
    '+bar',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.ok(error, 'mismatch should produce an error');
  assert.equal(result, before, 'original content must be returned untouched on error');
}

// 8. Update: whitespace-tolerant match (trailing whitespace differences)
{
  const before = 'line1  \nline2\nline3';
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    ' line1',
    '-line2',
    '+line2 modified',
    ' line3',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined, 'trailing whitespace should not block matching');
  assert.match(result, /line2 modified/);
}

// 9. Update: indentation-tolerant fallback for generated device patches
{
  const before = [
    'def main():',
    '    print(f"Camera opened: {dev} (640x480 MJPEG)")',
    '    output_tensors = []',
    '    return 0',
  ].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: usb_yolov5_web.py',
    '@@',
    ' print(f"Camera opened: {dev} (640x480 MJPEG)")',
    '-output_tensors = []',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined, 'leading indentation differences should not block context matching');
  assert.equal(result, [
    'def main():',
    '    print(f"Camera opened: {dev} (640x480 MJPEG)")',
    '    return 0',
  ].join('\n'));
}

// 10. Multi-hunk patch: Update + Add + Delete in one patch
{
  const before = [
    'def main():',
    '    if ok:',
    '    return 0',
  ].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: app.py',
    '@@',
    ' if ok:',
    '+print("done")',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined, 'indentation fallback should rebase unindented inserted lines');
  assert.equal(result, [
    'def main():',
    '    if ok:',
    '    print("done")',
    '    return 0',
  ].join('\n'));
}

// 11. Update: ambiguous repeated context should fail instead of editing the first match
{
  const before = [
    'def first():',
    '    print("ready")',
    'def second():',
    '    print("ready")',
  ].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: app.py',
    '@@',
    ' print("ready")',
    '+return 0',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.ok(error?.includes('无法唯一定位'), 'ambiguous context should report a uniqueness error');
  assert.equal(result, before, 'ambiguous patches must leave original content untouched');
}

// 12. Update: repeated short lines can still be edited when context is specific
{
  const before = [
    'def first():',
    '    print("ready")',
    'def second():',
    '    print("ready")',
  ].join('\n');
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: app.py',
    '@@',
    ' def second():',
    ' print("ready")',
    '+return 0',
    '*** End Patch',
  ].join('\n'));
  const { result, error } = applyUpdateHunk(before, patch.hunks[0]);
  assert.equal(error, undefined, 'specific context should disambiguate repeated lines');
  assert.equal(result, [
    'def first():',
    '    print("ready")',
    'def second():',
    '    print("ready")',
    '    return 0',
  ].join('\n'));
}

// 13. Multi-hunk patch: Update + Add + Delete in one patch
{
  const patch = parsePatch([
    '*** Begin Patch',
    '*** Update File: existing.ts',
    '@@',
    '-old',
    '+new',
    '*** Add File: brand-new.ts',
    '+hello',
    '*** Delete File: dead.ts',
    '*** End Patch',
  ].join('\n'));
  assert.equal(patch.hunks.length, 3);
  assert.deepEqual(
    patch.hunks.map((h) => h.type),
    ['update', 'add', 'delete'],
  );
}

console.log('[PASS] Apply Patch core: parser, update applier, error semantics');
