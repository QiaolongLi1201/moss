#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildApprovalDetailLines } from '../dist/cli/approval-detail.js';

// Test that editFileDetail shows a minimal diff, not all old/new lines
{
  const oldContent = `line 1
line 2
line 3
line 4
line 5`;
  const newContent = `line 1
line 2 CHANGED
line 3
line 4
line 5`;
  
  const lines = buildApprovalDetailLines('edit_file', 'local_write', {
    old_string: oldContent,
    new_string: newContent,
  });
  
  // Should show a minimal diff with context ellipsis, not all 5 lines removed + 5 lines added
  assert.ok(lines.some((l) => l.startsWith('  …')), 'should show context ellipsis for unchanged lines');
  assert.ok(lines.some((l) => l.startsWith('- line 2')), 'should show the removed line');
  assert.ok(lines.some((l) => l.startsWith('+ line 2 CHANGED')), 'should show the added line');
  
  // The key assertion: we should NOT have all 5 old lines and all 5 new lines
  const minusLines = lines.filter((l) => l.startsWith('- ') && !l.startsWith('  …'));
  const plusLines = lines.filter((l) => l.startsWith('+ ') && !l.startsWith('  …'));
  assert.equal(minusLines.length, 1, 'should only show the 1 changed old line, not all 5');
  assert.equal(plusLines.length, 1, 'should only show the 1 changed new line, not all 5');
}

console.log('[PASS] editFileDetail uses minimal diff');
