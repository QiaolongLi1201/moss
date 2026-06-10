#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-device-connect.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  connectDeviceForSession,
  disconnectDeviceForSession,
  parseDeviceConnectArgs,
} from '../dist/cli/device-connect.js';

function fakeAgent(initialTools = []) {
  const removed = [];
  const registered = [];
  const tools = new Map(initialTools.map((tool) => [tool.name, tool]));
  return {
    removed,
    registered,
    config: { extraPromptLayers: [] },
    tools: {
      get(name) {
        return tools.get(name);
      },
      remove(name) {
        removed.push(name);
        tools.delete(name);
      },
      register(tool) {
        registered.push(tool.name);
        tools.set(tool.name, tool);
      },
    },
  };
}

{
  const parsed = parseDeviceConnectArgs('root@192.168.1.10 --port 40023 --key ~/.ssh/id_rsa', {});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.config.host, '192.168.1.10');
  assert.equal(parsed.config.user, 'root');
  assert.equal(parsed.config.port, 40023);
  assert.equal(parsed.config.keyPath, '~/.ssh/id_rsa');
  assert.equal(parsed.verify, true, 'verification is on by default');
}

{
  const parsed = parseDeviceConnectArgs('rdk-board --password secret', {
    DMOSS_DEVICE_USER: 'ubuntu',
    DMOSS_DEVICE_PORT: '2222',
  });
  assert.equal(parsed.config.host, 'rdk-board');
  assert.equal(parsed.config.user, 'ubuntu');
  assert.equal(parsed.config.port, 2222);
  assert.equal(parsed.config.password, 'secret');
}

{
  const parsed = parseDeviceConnectArgs('192.168.1.10 --no-verify', {});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.verify, false, '--no-verify disables the probe');
  assert.equal(parsed.mode, 'board', 'board mode is the default');
}

{
  const parsed = parseDeviceConnectArgs('192.168.1.10 --hybrid', {});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.mode, 'hybrid', '--hybrid keeps local tools');
}

assert.match(parseDeviceConnectArgs('', {}).error, /Usage: \/connect/);
assert.match(parseDeviceConnectArgs('', {}).error, /--password/, 'usage documents --password');
assert.match(parseDeviceConnectArgs('', {}).error, /--no-verify/, 'usage documents --no-verify');
assert.match(parseDeviceConnectArgs('192.168.1.10 --bad', {}).error, /Unsupported \/connect option/);
assert.match(parseDeviceConnectArgs('192.168.1.10 extra', {}).error, /Unexpected \/connect argument/);

// Probe failure: no tools registered, no runtime.device, message says FAILED.
{
  const agent = fakeAgent();
  const runtime = {};
  const result = await connectDeviceForSession(agent, runtime, {
    host: '192.168.127.10',
    user: 'root',
    port: 22,
  }, {
    probe: async () => ({ ok: false, detail: 'Authentication failed for root@192.168.127.10:22.', kind: 'auth' }),
  });
  assert.equal(result.ok, false, 'failed probe must report ok=false');
  assert.match(result.message, /FAILED/, 'failed probe must not claim Connected');
  assert.match(result.message, /authentication rejected/);
  assert.doesNotMatch(result.message, /Connected to/);
  assert.equal(
    result.retryInput,
    '/connect root@192.168.127.10 --password ',
    'auth failure must offer a pre-filled retry command',
  );
  assert.equal(agent.registered.length, 0, 'failed probe must not register device tools');
  assert.equal(runtime.device, undefined, 'failed probe must not set runtime.device');
}

// Probe success (hybrid): device tools registered alongside local tools.
{
  const agent = fakeAgent();
  const runtime = {};
  let probed = 0;
  const result = await connectDeviceForSession(agent, runtime, {
    host: '192.168.1.10',
    user: 'root',
    port: 40023,
  }, {
    mode: 'hybrid',
    probe: async () => {
      probed += 1;
      return { ok: true, detail: 'rdk-x5' };
    },
  });
  assert.equal(probed, 1, 'probe runs exactly once');
  assert.equal(result.ok, true);
  assert.deepEqual(runtime.device, { host: '192.168.1.10', user: 'root', port: 40023 });
  assert.ok(agent.registered.includes('device_exec'));
  assert.ok(agent.registered.includes('device_resources'));
  assert.ok(agent.registered.includes('ros2_topic_list'));
  assert.ok(!agent.registered.includes('read_file'), 'hybrid mode must not displace local file tools');
  assert.deepEqual(agent.removed, agent.registered, 'session reconnect replaces existing device tools by name first');
  assert.match(result.message, /Connected to root@192\.168\.1\.10:40023/);
  assert.match(result.message, /verified, remote hostname: rdk-x5/);
  assert.equal(runtime.deviceSession.boardMode, false);
  assert.equal(agent.config.extraPromptLayers.length, 0, 'hybrid mode adds no board prompt layer');
}

// Board mode (default): local tools displaced, prompt layer added, disconnect restores everything.
{
  const localExec = { name: 'exec', description: 'local exec' };
  const localRead = { name: 'read_file', description: 'local read' };
  const localPatch = { name: 'apply_patch', description: 'local patch' };
  const agent = fakeAgent([localExec, localRead, localPatch]);
  const runtime = {};
  const result = await connectDeviceForSession(agent, runtime, {
    host: '192.168.1.10',
    user: 'root',
    port: 22,
  }, {
    probe: async () => ({ ok: true, detail: 'rdk-x5' }),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /BOARD MODE/);
  assert.equal(runtime.deviceSession.boardMode, true);
  // board exec replaced the local one
  const boardExec = agent.tools.get('exec');
  assert.ok(boardExec, 'exec must exist in board mode');
  assert.notEqual(boardExec, localExec, 'board exec must replace local exec');
  assert.match(boardExec.description, /ON THE CONNECTED BOARD/);
  assert.match(agent.tools.get('read_file').description, /BOARD/i);
  // suspended local-only tools are gone
  assert.equal(agent.tools.get('apply_patch'), undefined, 'apply_patch suspended in board mode');
  // prompt layer pushed
  assert.equal(agent.config.extraPromptLayers.length, 1);
  assert.match(agent.config.extraPromptLayers[0], /Board Mode Active/);

  // disconnect: locals restored exactly, layer removed, runtime cleared
  const bye = disconnectDeviceForSession(agent, runtime);
  assert.match(bye, /Disconnected from root@192\.168\.1\.10:22/);
  assert.match(bye, /restored 3 local tools/);
  assert.equal(agent.tools.get('exec'), localExec, 'local exec restored by reference');
  assert.equal(agent.tools.get('read_file'), localRead);
  assert.equal(agent.tools.get('apply_patch'), localPatch, 'suspended tool restored');
  assert.equal(agent.tools.get('device_exec'), undefined, 'device tools removed');
  assert.equal(agent.tools.get('ros2_topic_list'), undefined);
  assert.equal(agent.config.extraPromptLayers.length, 0, 'board prompt layer removed');
  assert.equal(runtime.device, null);
  assert.equal(runtime.deviceSession, null);
}

// Reconnect while board mode is active must not snapshot board tools as locals.
{
  const localExec = { name: 'exec', description: 'local exec' };
  const agent = fakeAgent([localExec]);
  const runtime = {};
  const probe = async () => ({ ok: true, detail: 'rdk-x5' });
  await connectDeviceForSession(agent, runtime, { host: '10.0.0.1', user: 'root', port: 22 }, { probe });
  await connectDeviceForSession(agent, runtime, { host: '10.0.0.2', user: 'root', port: 22 }, { probe });
  assert.match(agent.tools.get('exec').description, /10\.0\.0\.2/, 'second connect targets the new board');
  assert.equal(agent.config.extraPromptLayers.length, 1, 'exactly one board layer after reconnect');
  disconnectDeviceForSession(agent, runtime);
  assert.equal(agent.tools.get('exec'), localExec, 'original local exec survives a reconnect cycle');
}

// Disconnect with nothing connected: honest message, no crash.
{
  const agent = fakeAgent();
  const message = disconnectDeviceForSession(agent, {});
  assert.match(message, /No board is connected/);
}

// --no-verify: probe skipped, tools registered, message marked unverified.
{
  const agent = fakeAgent();
  const runtime = {};
  const result = await connectDeviceForSession(agent, runtime, {
    host: '192.168.1.10',
    user: 'root',
    port: 22,
  }, {
    skipVerify: true,
    probe: async () => {
      throw new Error('probe must not run with skipVerify');
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /Connected to root@192\.168\.1\.10:22/);
  assert.match(result.message, /unverified/);
  assert.ok(agent.registered.includes('device_exec'));
  assert.deepEqual(runtime.device, { host: '192.168.1.10', user: 'root', port: 22 });
}

console.log('[PASS] CLI runtime device connect');
