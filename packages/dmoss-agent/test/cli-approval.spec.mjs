#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createCliToolApprovalHook,
  describeCliToolApproval,
  renderCliApprovalPrompt,
  resolveCliSafetyMode,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';

function tool(name, sideEffectClass, planMode, extraMetadata = {}) {
  return {
    name,
    description: 'test tool',
    metadata: {
      ...(sideEffectClass ? { sideEffectClass } : {}),
      ...(planMode ? { planMode } : {}),
      ...extraMetadata,
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
      tool: tool('create_subagent', 'subagent', 'requires_user_confirmation'),
      input: { task: 'check the failing test' },
      sessionKey: 's',
    },
    'workspace-write',
  );
  const prompt = renderCliApprovalPrompt(preview, { task: 'check the failing test' });
  assert.match(prompt, /Moss wants to start a sub-agent task/);
  assert.match(prompt, /check the failing test/);
  assert.doesNotMatch(prompt, /write a file/);
}

{
  const subagentTool = tool('create_subagent', 'subagent', 'allow', { requiresApproval: false });
  const preview = describeCliToolApproval(
    {
      tool: subagentTool,
      input: { task: 'parallel research' },
      sessionKey: 's',
    },
    'workspace-write',
  );
  assert.equal(preview.requiresApproval, false, 'sub-agent dispatch should not ask for approval by default');
  assert.match(preview.decisionContext, /approval is not required/);

  const approve = createCliToolApprovalHook('workspace-write', {});
  assert.deepEqual(
    await approve({ tool: subagentTool, input: { task: 'parallel research' }, sessionKey: 's' }),
    { approved: true },
    'create_subagent should run without an interactive prompt',
  );
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'git status --short' },
      sessionKey: 's',
    },
    'read-only',
    {},
  );
  assert.equal(preview.toolName, 'exec');
  assert.equal(preview.sideEffect, 'readonly');
  assert.equal(preview.safetyMode, 'read-only');
  assert.equal(preview.requiresApproval, false);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /approval is not required/);

  const approve = createCliToolApprovalHook('read-only', {});
  assert.deepEqual(
    await approve({
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'git status --short' },
      sessionKey: 's',
    }),
    { approved: true },
    'obvious read-only exec commands should not require interactive approval',
  );
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
  );
  assert.equal(preview.toolName, 'exec');
  assert.equal(preview.sideEffect, 'local_write');
  assert.equal(preview.safetyMode, 'workspace-write');
  assert.equal(preview.requiresApproval, true);
  assert.equal(preview.trusted, false);
  assert.equal(preview.denied, false);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /workspace-write safety mode allows local_write/);
  assert.match(preview.inputPreview, /npm test/);
}

{
  const riskyCommands = [
    'cat /etc/passwd',
    'sed -i.bak -n "1,2p" notes.md',
    'find . -delete',
    'git branch feature-from-approval-test',
  ];
  for (const command of riskyCommands) {
    const preview = describeCliToolApproval(
      {
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command },
        sessionKey: 's',
      },
      'workspace-write',
      {},
    );
    assert.equal(preview.sideEffect, 'local_write', `${command} should not be treated as read-only`);
    assert.equal(preview.requiresApproval, true, `${command} should still require approval`);
  }
}

{
  const approve = createCliToolApprovalHook('read-only', {}, { deniedTools: ['exec'] });
  const denied = await approve({
    tool: tool('exec', 'local_write', 'requires_user_confirmation'),
    input: { command: 'git status --short' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'deniedTools must override read-only exec fast path');
  assert.match(denied.reason, /deniedTools/);
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
  assert.equal(preview.trustedPattern, 'exec');
  assert.equal(preview.denied, false);
  assert.equal(preview.deniedPattern, undefined);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /trustedTools \(exec\)/);
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('filesystem__write_file', 'local_write', 'requires_user_confirmation'),
      input: { path: 'notes.md' },
      sessionKey: 's',
    },
    'workspace-write',
    {},
    { trustedTools: ['filesystem__*'] },
  );
  assert.equal(preview.trusted, true);
  assert.equal(preview.trustedPattern, 'filesystem__*');
  assert.equal(preview.denied, false);
  assert.equal(preview.deniedPattern, undefined);
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /trustedTools \(filesystem__\*\)/);
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
      input: { path: 'notes.md' },
      sessionKey: 's',
    },
    'workspace-write',
    {},
    { trustedTools: ['write_*'], deniedTools: ['write_file'] },
  );
  assert.equal(preview.trusted, true);
  assert.equal(preview.trustedPattern, 'write_*');
  assert.equal(preview.denied, true);
  assert.equal(preview.deniedPattern, 'write_file');
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /deniedTools \(write_file\)/);
}

{
  const preview = describeCliToolApproval(
    {
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    },
    'workspace-write',
    { DMOSS_CLI_AUTO_APPROVE: '1' },
    { trustedTools: ['exec'], deniedTools: ['exec'] },
  );
  assert.equal(preview.trusted, true);
  assert.equal(preview.trustedPattern, 'exec');
  assert.equal(preview.denied, true);
  assert.equal(preview.deniedPattern, 'exec');
  assert.equal(preview.autoApproved, false);
  assert.match(preview.decisionContext, /deniedTools \(exec\)/);
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
  let fullPower = false;
  const approve = createCliToolApprovalHook('workspace-write', {}, {
    safetyModeOverride: () => (fullPower ? 'full-access' : undefined),
    autoApprove: () => fullPower,
    deniedTools: ['blocked_tool'],
  });
  const blockedByBaseMode = await approve({
    tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    input: { command: 'uptime' },
    sessionKey: 's',
  });
  assert.equal(blockedByBaseMode.approved, false, 'base workspace-write still blocks device mutation before /yolo');
  assert.match(blockedByBaseMode.reason, /workspace-write/);

  fullPower = true;
  assert.deepEqual(
    await approve({
      tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
      input: { command: 'uptime' },
      sessionKey: 's',
    }),
    { approved: true },
    '/yolo-style fullPower should allow full-access tools without a per-call prompt',
  );
  const denied = await approve({
    tool: tool('blocked_tool', 'local_write', 'requires_user_confirmation'),
    input: {},
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'deniedTools still overrides fullPower');
  assert.match(denied.reason, /deniedTools/);
}

{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    const approve = createCliToolApprovalHook('workspace-write', { DMOSS_CLI_AUTO_APPROVE: '1' }, {
      approvalPolicy: 'never',
      trustedTools: ['exec'],
      deniedTools: ['exec'],
    });
    const denied = await approve({
      tool: tool('exec', 'local_write', 'requires_user_confirmation'),
      input: { command: 'npm test' },
      sessionKey: 's',
    });
    assert.equal(denied.approved, false, 'deniedTools must override trustedTools and auto approval');
    assert.match(denied.reason, /deniedTools/);
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
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
    const approve = createCliToolApprovalHook('workspace-write', {}, { trustedTools: ['exec', 'filesystem__*'] });
    assert.deepEqual(
      await approve({
        tool: tool('exec', 'local_write', 'requires_user_confirmation'),
        input: { command: 'npm test' },
        sessionKey: 's',
      }),
      { approved: true },
      'trustedTools should approve exact allowed tool names without interactive stdin',
    );
    assert.deepEqual(
      await approve({
        tool: tool('filesystem__write_file', 'local_write', 'requires_user_confirmation'),
        input: { path: 'notes.md' },
        sessionKey: 's',
      }),
      { approved: true },
      'trustedTools should approve matching allowed tool glob patterns without interactive stdin',
    );
    assert.deepEqual(
      await approve({
        tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
        input: { path: 'a.txt', content: 'x' },
        sessionKey: 's',
      }),
      { approved: true },
      'headless workspace-write should auto-run mode-allowed local writes when no TTY exists',
    );
    const denied = await approve({
      tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
      input: { command: 'uptime' },
      sessionKey: 's',
    });
    assert.equal(denied.approved, false, 'headless workspace-write still blocks device mutation');
    assert.match(denied.reason, /workspace-write/);
    const readOnlyDenied = await createCliToolApprovalHook('read-only', {}, { trustedTools: ['exec'] })({
      tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
      input: { path: 'a.txt', content: 'x' },
      sessionKey: 's',
    });
    assert.equal(readOnlyDenied.approved, false, 'headless read-only still blocks local writes');
    assert.match(readOnlyDenied.reason, /read-only/);
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
    assert.match(prompt, /Moss wants to run a local command/);
    assert.match(prompt, /echo sk-t\*\*\*00/);
    assert.match(prompt, /Scope: workspace command/);
    assert.match(prompt, /Allow once, trust this workspace for the session, or deny/);
    assert.doesNotMatch(prompt, /side effect:/);
    assert.doesNotMatch(prompt, /policy:/);
    assert.doesNotMatch(prompt, /input:/);
    assert.doesNotMatch(prompt, /sk-test-00000000000000000000/);
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
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
    const approve = createCliToolApprovalHook('workspace-write', {}, { trustedTools: ['filesystem__*'] });
    assert.deepEqual(
      await approve({
        tool: tool('filesystem__write_file', 'local_write', 'requires_user_confirmation'),
        input: { path: 'notes.md' },
        sessionKey: 's',
      }),
      { approved: true },
      'configured trusted glob should approve before prompting',
    );
    assert.equal(prompt, '', 'trusted glob should not prompt');
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
    const approve = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: '/tmp/moss-trusted-project' });
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
        tool: tool('write_file', 'local_write', 'requires_user_confirmation'),
        input: { path: 'a.txt', content: 'x' },
        sessionKey: 's',
      }),
      { approved: true },
      'a should trust other workspace-local tools for the rest of the session',
    );
    assert.deepEqual(
      await approve({
        tool: tool('apply_patch', 'local_write', 'requires_user_confirmation'),
        input: { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch' },
        sessionKey: 's',
      }),
      { approved: true },
      'workspace trust should cover apply_patch too',
    );
    const deniedMemoryTool = await approve({
      tool: tool('remember_fact', 'memory_write', 'requires_user_confirmation'),
      input: { text: 'remember this' },
      sessionKey: 's',
    });
    assert.equal(deniedMemoryTool.approved, false, 'workspace trust must not trust non-workspace scopes');
    assert.equal(promptCount, 2, 'trusted workspace tools should not prompt again, but non-workspace scopes should');
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

// --- Board mode (/connect) auto-approve ---------------------------------------
// Live board-mode signal: a getter the hook closes over, flipped by /connect.
{
  let board = false;
  const opts = { boardMode: () => board };

  // (a) In board mode, device/workspace tools are APPROVED without prompting,
  //     under base workspace-write, even though they require approval normally.
  board = true;
  const approve = createCliToolApprovalHook('workspace-write', {}, opts);

  for (const t of [
    tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    tool('write_file', 'local_write', 'requires_user_confirmation'),
    tool('ros2_launch', 'device_mutation', 'requires_user_confirmation'),
    tool('edit_file', 'device_mutation', 'requires_user_confirmation'),
    tool('move_file', 'device_mutation', 'requires_user_confirmation'),
    tool('ros2_service_call', 'device_mutation', 'requires_user_confirmation'),
  ]) {
    const input = t.name === 'device_exec' ? { command: 'systemctl restart tros' } : { path: '/etc/motd' };
    assert.deepEqual(
      await approve({ tool: t, input, sessionKey: 's' }),
      { approved: true },
      `board mode should auto-approve ${t.name} under workspace-write without prompting`,
    );
  }

  // Metadata is untouched — board mode changes only the decision, not the class.
  const launchPreview = describeCliToolApproval(
    { tool: tool('ros2_launch', 'device_mutation', 'requires_user_confirmation'), input: {}, sessionKey: 's' },
    'workspace-write',
    {},
    opts,
  );
  assert.equal(launchPreview.sideEffect, 'device_mutation', 'ros2_launch keeps device_mutation metadata');
  assert.equal(launchPreview.boardAutoApproved, true, 'ros2_launch is board-auto-approved in board mode');
  assert.match(launchPreview.decisionContext, /board mode/);

  // (c) NO REGRESSION: flip board mode off — same hook, same getter — and a
  //     device_mutation is blocked again by workspace-write.
  board = false;
  const denied = await approve({
    tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    input: { command: 'uptime' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'outside board mode, workspace-write blocks device_mutation');
  assert.match(denied.reason, /workspace-write/);
}

// read-only stays safe even on a board: board mode does NOT override the
// explicit read-only opt-in (documented tradeoff).
{
  const approve = createCliToolApprovalHook('read-only', {}, { boardMode: () => true });
  const denied = await approve({
    tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    input: { command: 'reboot' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'read-only must stay safe even in board mode');
  assert.match(denied.reason, /read-only/);
}

// deniedTools still wins over board-mode auto-approval.
{
  const approve = createCliToolApprovalHook('workspace-write', {}, {
    boardMode: () => true,
    deniedTools: ['device_exec'],
  });
  const denied = await approve({
    tool: tool('device_exec', 'device_mutation', 'requires_user_confirmation'),
    input: { command: 'ls' },
    sessionKey: 's',
  });
  assert.equal(denied.approved, false, 'deniedTools overrides board-mode auto-approval');
  assert.match(denied.reason, /deniedTools/);
}

console.log('[PASS] CLI approval safety modes gate mutating tools');
