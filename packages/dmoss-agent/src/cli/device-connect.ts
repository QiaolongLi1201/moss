import type { DmossAgent } from '../core/index.js';
import { createDeviceDiagnosticsTools } from '../tools/device-diagnostics.js';
import { createRos2Tools } from '../tools/device-ros2.js';
import { createDeviceSshTools, type DeviceSshConfig } from '../tools/device-ssh.js';
import type { CliRuntimeStatus } from './onboarding.js';

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseDeviceConnectArgs(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): { config?: DeviceSshConfig; error?: string } {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    return { error: 'Usage: /connect <board-ip-or-hostname> [--user root] [--port 22] [--key ~/.ssh/id_rsa]' };
  }

  let target = '';
  let user = env.DMOSS_DEVICE_USER || 'root';
  let port = parsePort(env.DMOSS_DEVICE_PORT) ?? 22;
  let keyPath = env.DMOSS_DEVICE_KEY;
  let password = env.DMOSS_DEVICE_PASSWORD;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--user' || arg === '-u') {
      user = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--user=')) {
      user = arg.slice('--user='.length);
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      port = parsePort(args[++i]) ?? port;
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = parsePort(arg.slice('--port='.length)) ?? port;
      continue;
    }
    if (arg === '--key') {
      keyPath = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--key=')) {
      keyPath = arg.slice('--key='.length);
      continue;
    }
    if (arg === '--password') {
      password = args[++i] || '';
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      return { error: `Unsupported /connect option: ${arg}` };
    }
    if (target) return { error: `Unexpected /connect argument: ${arg}` };
    target = arg;
  }

  if (!target) {
    return { error: 'Usage: /connect <board-ip-or-hostname> [--user root] [--port 22]' };
  }
  if (target.includes('@')) {
    const [rawUser, rawHost] = target.split('@', 2);
    if (rawUser) user = rawUser;
    target = rawHost || target;
  }
  if (!target.trim()) return { error: 'Board host is empty.' };

  return {
    config: {
      host: target.trim(),
      user: user || 'root',
      port,
      ...(password ? { password } : {}),
      ...(keyPath ? { keyPath } : {}),
    },
  };
}

export function connectDeviceForSession(
  agent: DmossAgent,
  runtime: CliRuntimeStatus | undefined,
  config: DeviceSshConfig,
): string {
  const tools = [
    ...createDeviceSshTools(config),
    ...createDeviceDiagnosticsTools(config),
    ...createRos2Tools(config),
  ];
  for (const tool of tools) {
    agent.tools.remove(tool.name);
    agent.tools.register(tool);
  }
  if (runtime) {
    runtime.device = { host: config.host, user: config.user, port: config.port };
  }
  return [
    `[device] Connected to ${config.user || 'root'}@${config.host}:${config.port || 22} for this session.`,
    'Device and ROS/TROS tools are now available. Credentials are read from DMOSS_DEVICE_PASSWORD or DMOSS_DEVICE_KEY unless passed explicitly.',
  ].join('\n');
}
