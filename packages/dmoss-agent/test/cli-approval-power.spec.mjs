#!/usr/bin/env node
/**
 * "Full power" approval behaviors: --full-access / /yolo imply no per-call
 * prompt, headless auto-approves mode-allowed tools, and the hard floor
 * (read-only blocks all mutation, deniedTools wins) still holds.
 */
import assert from 'node:assert/strict';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
} from '../dist/cli/approval.js';

function tool(name, sideEffectClass, planMode = 'requires_user_confirmation') {
  return {
    name,
    description: 'test tool',
    metadata: { ...(sideEffectClass ? { sideEffectClass } : {}), ...(planMode ? { planMode } : {}) },
    inputSchema: { type: 'object', properties: {} },
    async execute() { return 'ok'; },
  };
}

const withTTY = (value, fn) => async () => {
  const old = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process.stdin, 'isTTY', { value: old, configurable: true }); }
};

// 1. full-access mode implies no per-call prompt for a mutating tool.
await withTTY(true, async () => {
  const approve = createCliToolApprovalHook('full-access', {});
  assert.deepEqual(
    await approve({ tool: tool('device_exec', 'device_mutation'), input: { command: 'systemctl restart x' }, sessionKey: 's' }),
    { approved: true },
    'full-access should auto-approve device_mutation without a prompt',
  );
})();

// 2. /yolo path: workspace-write base + fullPower getters → full-access + auto-approve.
await withTTY(true, async () => {
  let yolo = false;
  const approve = createCliToolApprovalHook('workspace-write', {}, {
    safetyModeOverride: () => (yolo ? 'full-access' : undefined),
    autoApprove: () => yolo,
  });
  const call = () => approve({ tool: tool('device_exec', 'device_mutation'), input: { command: 'uptime' }, sessionKey: 's' });
  const before = await call();
  assert.equal(before.approved, false, 'before /yolo, device_mutation is blocked by workspace-write');
  yolo = true;
  assert.deepEqual(await call(), { approved: true }, 'after /yolo, device_mutation runs without a prompt');
})();

// 3. read-only stays safe even with autoApprove on (the floor).
await withTTY(true, async () => {
  const approve = createCliToolApprovalHook('read-only', {}, { autoApprove: () => true });
  const denied = await approve({ tool: tool('write_file', 'local_write'), input: { path: 'a' }, sessionKey: 's' });
  assert.equal(denied.approved, false, 'read-only blocks mutation even under full power');
  assert.match(denied.reason, /read-only/);
})();

// 4. deniedTools wins over full power.
await withTTY(true, async () => {
  const approve = createCliToolApprovalHook('full-access', {}, { deniedTools: ['device_exec'] });
  const denied = await approve({ tool: tool('device_exec', 'device_mutation'), input: { command: 'ls' }, sessionKey: 's' });
  assert.equal(denied.approved, false, 'deniedTools overrides full-access auto-approval');
  assert.match(denied.reason, /deniedTools/);
})();

// 5. MCP/browser tools (external_message) are PROMPTABLE in workspace-write (allowed by mode),
//    not hard-blocked — and auto-approved under full power.
await withTTY(true, async () => {
  const preview = describeCliToolApproval(
    { tool: tool('filesystem__write', 'external_message'), input: {}, sessionKey: 's' },
    'workspace-write', {},
  );
  assert.equal(preview.sideEffect, 'external_message');
  assert.doesNotMatch(preview.decisionContext, /blocked by workspace-write/, 'external_message must not be hard-blocked in workspace-write');
  assert.equal(preview.requiresApproval, true, 'it still prompts (user consents per call)');

  const approve = createCliToolApprovalHook('full-access', {});
  assert.deepEqual(
    await approve({ tool: tool('filesystem__write', 'external_message'), input: {}, sessionKey: 's' }),
    { approved: true },
    'under full power an MCP tool runs without a prompt',
  );
})();

// 6. Headless (no TTY): mode-allowed tools auto-run; read-only still blocks.
await withTTY(false, async () => {
  const approveWs = createCliToolApprovalHook('workspace-write', {});
  assert.deepEqual(
    await approveWs({ tool: tool('write_file', 'local_write'), input: { path: 'a', content: 'x' }, sessionKey: 's' }),
    { approved: true },
    'headless workspace-write should auto-run a mode-allowed local_write (no TTY to prompt)',
  );
  const denied = await approveWs({ tool: tool('device_exec', 'device_mutation'), input: { command: 'x' }, sessionKey: 's' });
  assert.equal(denied.approved, false, 'headless still blocks what the mode does NOT allow (device_mutation in workspace-write)');

  const approveRo = createCliToolApprovalHook('read-only', {});
  const roDenied = await approveRo({ tool: tool('write_file', 'local_write'), input: { path: 'a', content: 'x' }, sessionKey: 's' });
  assert.equal(roDenied.approved, false, 'headless read-only still blocks all mutation');
})();

console.log('[PASS] full-power approval: --full-access/yolo no-prompt, headless auto-run, floor intact');
