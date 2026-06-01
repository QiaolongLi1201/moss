#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
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
  const preview = describeCliToolApproval(
    {
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    },
    'workspace-write',
    {},
  );
  assert.equal(preview.toolName, 'exec');
  assert.equal(preview.sideEffect, 'local_write');
  assert.equal(preview.safetyMode, 'workspace-write');
  assert.equal(preview.requiresApproval, true);
  assert.equal(preview.trusted, false);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /workspace-write safety mode allows local_write/);
  assert.match(preview.inputPreview, /npm test/);
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    },
    'workspace-write',
    {},
    { trustedTools: ['exec'] },
  );
  assert.equal(preview.trusted, true);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /trustedTools/);
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    },
    'read-only',
    { DMOSS_CLI_AUTO_APPROVE: '1' },
  );
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /blocked by read-only safety mode/);
}

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
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {}, { trustedTools: ['exec'] });
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm test' },
        sessionKey: 's',
      }),
      { approved: true },
      'trustedTools should approve exact allowed tool names without interactive stdin',
    );
    const denied = await approve({
      tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
      input: { path: 'a.txt', content: 'x' },
      sessionKey: 's',
    });
    assert.equal(denied.approved, false, 'untrusted mutating tools still require approval');
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
  const approve = createCliToolApprovalHook('read-only', {}, { trustedTools: ['exec'] });
  const denied = await approve({
    tool: tool('exec', 'local_write', 'requires_user_confirmation'),
    input: { command: 'npm test' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'trustedTools must not override read-only safety mode');
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
    assert.match(prompt, /side effect: local_write/);
    assert.match(prompt, /policy: workspace-write safety mode allows local_write, but approval is required/);
    assert.match(prompt, /input:/);
    assert.doesNotMatch(prompt, /sk-test-00000000000000000000/);
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  let promptCount = 0;
  const answers = ['a', ''];
  setCliApprovalAsker(async () => {
    promptCount++;
    return answers.shift() ?? '';
  });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {});
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm test' },
        sessionKey: 's',
      }),
      { approved: true },
      'a should approve the current tool call',
    );
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm run build' },
        sessionKey: 's',
      }),
      { approved: true },
      'a should trust the same tool for the rest of the session',
    );
    const deniedOtherTool = await approve({
      tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
      input: { path: 'a.txt', content: 'x' },
      sessionKey: 's',
    });
    assert.equal(deniedOtherTool.approved, false, 'trusting one tool must not trust other tools');
    assert.equal(promptCount, 2, 'session-trusted tools should not prompt again, but other tools should');
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  let promptCount = 0;
  setCliApprovalAsker(async () => {
    promptCount++;
    return 'always';
  });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {});
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm test' },
        sessionKey: 's',
      }),
      { approved: true },
      'always should approve the current tool call',
    );
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm run build' },
        sessionKey: 's',
      }),
      { approved: true },
      'always should trust the same tool for the rest of the session',
    );
    assert.equal(promptCount, 1, 'always should not prompt again for the same tool in the same hook session');
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

console.log('[PASS] CLI approval safety modes gate mutating tools');
