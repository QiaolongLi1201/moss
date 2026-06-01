#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createCliToolApprovalHook,
  resolveCliSafetyMode,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';

function tool(name, sideEffectClass, planMode) {
  return {
    name,
    description: 'test tool',
    metadata: {
      ...(sideEffectClass ? { sideEffectClass } : {}),
      ...(planMode ? { planMode } : {}),
    },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
  };
}

assert.equal(resolveCliSafetyMode(['--read-only'], {}), 'read-only');
assert.equal(resolveCliSafetyMode(['--workspace-write'], {}), 'workspace-write');
assert.equal(resolveCliSafetyMode(['--full-access'], {}), 'full-access');
assert.equal(resolveCliSafetyMode([], { DMOSS_SAFETY_MODE: 'full' }), 'full-access');
assert.equal(resolveCliSafetyMode([], {}), 'workspace-write');

{
  const approve = createCliToolApprovalHook('read-only', {});
  assert.deepEqual(
    await approve({ tool: tool('read_file', 'readonly'), input: { path: 'README.md' }, sessionKey: 's' }),
    { approved: true },
  );
  const denied = await approve({
    tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
    input: { path: 'a.txt', content: 'x' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false);
  assert.match(denied.reason, /read-only/);
  const patchDenied = await approve({
    tool: tool('apply_patch', 'local_write', 'requires_user_confirmation'),
    input: { patch: '*** Begin Patch\n*** End Patch' },
    sessionKey: 's',
  });
  assert.equal(patchDenied.approved, false);
}

{
  const approve = createCliToolApprovalHook('workspace-write', { DMOSS_CLI_AUTO_APPROVE: '1' });
  assert.deepEqual(
    await approve({
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    }),
    { approved: true },
  );
  const denied = await approve({
    tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    input: { command: 'reboot' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false);
  assert.match(denied.reason, /workspace-write/);
}

{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {}, { approvalPolicy: 'never' });
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm test' },
        sessionKey: 's',
      }),
      { approved: true },
      'explicit approvalPolicy=never should approve allowed mutating tools without env mutation',
    );
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

{
  const approve = createCliToolApprovalHook('full-access', { DMOSS_CLI_AUTO_APPROVE: '1' });
  assert.deepEqual(
    await approve({
      tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
      input: { command: 'uptime' },
      sessionKey: 's',
    }),
    { approved: true },
  );
}

{
  const approve = createCliToolApprovalHook('read-only', { DMOSS_CLI_AUTO_APPROVE: '1' });
  const denied = await approve({
    tool: tool('exec', 'local_write', 'requires_user_confirmation'),
    input: { command: 'npm test' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'auto-approve must not override read-only mode');
}

{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  let prompt = '';
  setCliApprovalAsker(async (question) => {
    prompt = question;
    return '';
  });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {});
    const denied = await approve({
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'echo sk-test-00000000000000000000' },
      sessionKey: 's',
    });
    assert.equal(denied.approved, false, 'blank approval response should default to deny');
    assert.match(prompt, /\[approval\]/);
    assert.doesNotMatch(prompt, /sk-test-00000000000000000000/);
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

console.log('[PASS] CLI approval safety modes gate mutating tools');
