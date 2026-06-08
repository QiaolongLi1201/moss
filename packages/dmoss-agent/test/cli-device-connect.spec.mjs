#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-device-connect.spec.mjs
 */
import assert from 'node:assert/strict';
import {
  connectDeviceForSession,
  parseDeviceConnectArgs,
} from '../dist/cli/device-connect.js';

{
  const parsed = parseDeviceConnectArgs('root@192.168.1.10 --port 40023 --key ~/.ssh/id_rsa', {});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.config.host, '192.168.1.10');
  assert.equal(parsed.config.user, 'root');
  assert.equal(parsed.config.port, 40023);
  assert.equal(parsed.config.keyPath, '~/.ssh/id_rsa');
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

assert.match(parseDeviceConnectArgs('', {}).error, /Usage: \/connect/);
assert.match(parseDeviceConnectArgs('192.168.1.10 --bad', {}).error, /Unsupported \/connect option/);
assert.match(parseDeviceConnectArgs('192.168.1.10 extra', {}).error, /Unexpected \/connect argument/);

{
  const removed = [];
  const registered = [];
  const runtime = {};
  const message = connectDeviceForSession({
    tools: {
      remove(name) {
        removed.push(name);
      },
      register(tool) {
        registered.push(tool.name);
      },
    },
  }, runtime, {
    host: '192.168.1.10',
    user: 'root',
    port: 40023,
  });
  assert.deepEqual(runtime.device, { host: '192.168.1.10', user: 'root', port: 40023 });
  assert.ok(registered.includes('device_exec'));
  assert.ok(registered.includes('device_resources'));
  assert.ok(registered.includes('ros2_topic_list'));
  assert.deepEqual(removed, registered, 'session reconnect replaces existing device tools by name first');
  assert.match(message, /Connected to root@192\.168\.1\.10:40023/);
}

console.log('[PASS] CLI runtime device connect');
