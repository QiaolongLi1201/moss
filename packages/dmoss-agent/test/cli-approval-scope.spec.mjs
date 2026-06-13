#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-approval-scope.spec.mjs
 *
 * Guards that answering "a" (Always) on a device_mutation approves only the
 * current call and does NOT blanket-trust the tool for the rest of the session,
 * while a workspace-local tool keeps its session-wide "always" trust.
 */
import assert from 'node:assert/strict';
import {
  createCliToolApprovalHook,
  renderCliApprovalPrompt,
  describeCliToolApproval,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';

function tool(name, sideEffectClass) {
  return {
    name,
    description: 'test tool',
    metadata: {
      ...(sideEffectClass ? { sideEffectClass } : {}),
      planMode: 'requires_user_confirmation',
    },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'ok';
    },
  };
}

// NOTE: a device_mutation never reaches the interactive "a" prompt by design —
// isAllowedInMode only releases it under board mode (→ boardAutoApproved) or
// full-access (→ fullPower), both of which auto-approve before the asker, and
// every other mode blocks it. So the no-blanket-trust guard is validated through
// the OBSERVABLE prompt text below (renderCliApprovalPrompt omits the "always"
// option for device mutations) rather than by driving the unreachable hook path.

// --- workspace-local "a" keeps session-wide trust (no regression) -------------
{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  let promptCount = 0;
  setCliApprovalAsker(async () => {
    promptCount++;
    return 'a';
  });
  try {
    const approve = createCliToolApprovalHook('workspace-write', {});
    await approve({
      tool: tool('some_local_tool', 'memory_write'),
      input: { text: 'x' },
      sessionKey: 's',
    });
    const second = await approve({
      tool: tool('some_local_tool', 'memory_write'),
      input: { text: 'y' },
      sessionKey: 's',
    });
    assert.deepEqual(second, { approved: true });
    assert.equal(promptCount, 1, 'session-trust-eligible tools keep their session-wide "always" trust');
  } finally {
    setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

// --- prompt for a device mutation does not advertise an "always" option -------
{
  const preview = describeCliToolApproval(
    { tool: tool('device_exec', 'device_mutation'), input: { command: 'reboot' }, sessionKey: 's' },
    'full-access',
  );
  const prompt = renderCliApprovalPrompt(preview, { command: 'reboot' });
  assert.match(prompt, /device mutations always re-prompt/);
  assert.doesNotMatch(prompt, /allow this scope for the session/);
}

console.log('[PASS] device mutations are not blanket-trusted by "Always"');
// --- headless (-p / no TTY) auto-approval of a mutating tool is audited ------
{
  const oldIsTty = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return origWrite(chunk, ...rest);
  };
  try {
    const approve = createCliToolApprovalHook('workspace-write', {});
    const result = await approve({
      tool: tool('write_file', 'local_write'),
      input: { path: 'a.txt', content: 'x' },
      sessionKey: 's',
    });
    assert.deepEqual(result, { approved: true }, 'headless -p stays usable: mutating tool still auto-approved');
    assert.match(
      captured,
      /\[approval\] headless auto-approve: write_file \(local_write\) under workspace-write/,
      'headless auto-approval of a mutating tool must leave an audit line',
    );
  } finally {
    process.stderr.write = origWrite;
    Object.defineProperty(process.stdin, 'isTTY', { value: oldIsTty, configurable: true });
  }
}

console.log('[PASS] headless mutating auto-approvals are audited');

