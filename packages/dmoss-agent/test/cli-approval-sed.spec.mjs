#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createCliToolApprovalHook, describeCliToolApproval } from '../dist/cli/approval.js';

function tool(name, sideEffectClass) {
  return {
    name,
    description: 'test tool',
    metadata: { ...(sideEffectClass ? { sideEffectClass } : {}), planMode: 'requires_user_confirmation' },
    inputSchema: { type: 'object', properties: {} },
    async execute() { return 'ok'; },
  };
}

// sed without -i (default behavior): prints to stdout, does not mutate file
// Should be classified as readonly
{
  const preview = describeCliToolApproval(
    { tool: tool('exec', 'local_write'), input: { command: 'sed s/a/b/ file.txt' }, sessionKey: 's' },
    'read-only',
  );
  assert.equal(preview.sideEffect, 'readonly', 'plain sed should be readonly');
  assert.equal(preview.requiresApproval, false);
}

// sed with -i (in-place): mutates the file
// Should be classified as local_write
{
  const preview = describeCliToolApproval(
    { tool: tool('exec', 'local_write'), input: { command: 'sed -i s/a/b/ file.txt' }, sessionKey: 's' },
    'workspace-write',
  );
  assert.equal(preview.sideEffect, 'local_write', 'sed -i should be local_write');
  assert.equal(preview.requiresApproval, true);
}

// sed with -n (quiet) but no -i: still readonly (just doesn't print matching lines)
{
  const preview = describeCliToolApproval(
    { tool: tool('exec', 'local_write'), input: { command: 'sed -n p file.txt' }, sessionKey: 's' },
    'read-only',
  );
  assert.equal(preview.sideEffect, 'readonly', 'sed -n should be readonly');
  assert.equal(preview.requiresApproval, false);
}

console.log('[PASS] isReadonlySed correctly identifies readonly sed commands');
