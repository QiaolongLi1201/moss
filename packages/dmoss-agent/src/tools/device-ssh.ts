/**
 * Device SSH Tools — connect to and execute commands on remote devices.
 *
 * These tools enable D-Moss to control physical hardware (RDK boards,
 * Jetson devices, Raspberry Pi, etc.) over SSH.
 *
 * Configuration:
 *   DMOSS_DEVICE_HOST     — Device IP or hostname
 *   DMOSS_DEVICE_USER     — SSH username (default: root)
 *   DMOSS_DEVICE_PASSWORD  — SSH password
 *   DMOSS_DEVICE_PORT     — SSH port (default: 22)
 *   DMOSS_DEVICE_KEY      — Path to SSH private key (alternative to password)
 */

import { execFileSync } from 'node:child_process';
import type { Tool } from '../core/tools/tool-types.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

export interface DeviceSshConfig {
  host: string;
  user?: string;
  password?: string;
  port?: number;
  keyPath?: string;
}

/** Escape a single shell argument for POSIX sh. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildSshCommand(config: DeviceSshConfig, remoteCmd: string): string[] {
  const user = config.user || 'root';
  const port = config.port || 22;
  const parts = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];

  if (config.keyPath) {
    parts.push('-i', config.keyPath);
  }

  parts.push('-p', String(port), `${user}@${config.host}`, shellEscape(remoteCmd));
  return parts;
}

export function createDeviceSshTools(config: DeviceSshConfig): Tool[] {
  const deviceExec: Tool = {
    name: 'device_exec',
    description: `Execute a shell command on the connected device (${config.host}) via SSH.`,
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the device' },
        timeout_ms: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
    async execute(input) {
      const timeout = Number(input.timeout_ms) || 30_000;
      const sshCmd = buildSshCommand(config, input.command);
      try {
        const sshBin = config.password ? 'sshpass' : 'ssh';
        const sshArgs = config.password ? ['-e', 'ssh', ...sshCmd] : sshCmd;
        const result = execFileSync(sshBin, sshArgs, {
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf-8',
          env: safeChildEnv(config.password ? { SSHPASS: config.password } : undefined),
        });
        return String(result).trim() || '(no output)';
      } catch (err: any) {
        const output = [err.stdout, err.stderr].filter(Boolean).map(String).join('\n').trim();
        return `Device command failed (exit ${err.status ?? 'unknown'}):\n${output || err.message}`;
      }
    },
  };

  const deviceInfo: Tool = {
    name: 'device_info',
    description: 'Get basic information about the connected device (hostname, OS, CPU, memory).',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const commands = [
        'echo "hostname: $(hostname)"',
        'echo "os: $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\"\\")"',
        'echo "kernel: $(uname -r)"',
        'echo "arch: $(uname -m)"',
        'echo "cpu: $(nproc) cores"',
        "echo \"memory: $(free -h | awk '/^Mem:/{print $2}') total, $(free -h | awk '/^Mem:/{print $3}') used\"",
        "echo \"disk: $(df -h / | awk 'NR==2{print $2}') total, $(df -h / | awk 'NR==2{print $3}') used\"",
        'echo "uptime: $(uptime -p 2>/dev/null || uptime)"',
      ];
      const sshCmd = buildSshCommand(config, commands.join(' && '));
      try {
        const sshBin = config.password ? 'sshpass' : 'ssh';
        const sshArgs = config.password ? ['-e', 'ssh', ...sshCmd] : sshCmd;
        const result = execFileSync(sshBin, sshArgs, {
          timeout: 15_000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
        return result.trim();
      } catch (err: any) {
        return `Failed to get device info: ${err.message}`;
      }
    },
  };

  const deviceFileRead: Tool = {
    name: 'device_file_read',
    description: 'Read a file from the connected device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path on the device' },
      },
      required: ['path'],
    },
    async execute(input) {
      const sshCmd = buildSshCommand(config, `cat ${shellEscape(input.path)}`);
      try {
        const sshBin = config.password ? 'sshpass' : 'ssh';
        const sshArgs = config.password ? ['-e', 'ssh', ...sshCmd] : sshCmd;
        const result = execFileSync(sshBin, sshArgs, {
          timeout: 15_000,
          encoding: 'utf-8',
          maxBuffer: 5 * 1024 * 1024,
        });
        const content = result.trim();
        if (content.length > 100_000) {
          return content.slice(0, 100_000) + '\n\n[... truncated]';
        }
        return content || '(empty file)';
      } catch (err: any) {
        return `Failed to read ${input.path}: ${err.message}`;
      }
    },
  };

  const deviceFileList: Tool = {
    name: 'device_file_list',
    description: 'List files in a directory on the connected device.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path on the device (default: /home)' },
      },
    },
    async execute(input) {
      const dir = input.path || '/home';
      const sshCmd = buildSshCommand(config, `ls -la ${shellEscape(dir)}`);
      try {
        const sshBin = config.password ? 'sshpass' : 'ssh';
        const sshArgs = config.password ? ['-e', 'ssh', ...sshCmd] : sshCmd;
        const result = execFileSync(sshBin, sshArgs, { timeout: 10_000, encoding: 'utf-8' });
        return result.trim();
      } catch (err: any) {
        return `Failed to list ${dir}: ${err.message}`;
      }
    },
  };

  return [deviceExec, deviceInfo, deviceFileRead, deviceFileList];
}

/**
 * Auto-detect device configuration from environment variables.
 */
export function getDeviceConfigFromEnv(): DeviceSshConfig | null {
  const host = process.env.DMOSS_DEVICE_HOST;
  if (!host) return null;

  return {
    host,
    user: process.env.DMOSS_DEVICE_USER || 'root',
    password: process.env.DMOSS_DEVICE_PASSWORD,
    port: parseInt(process.env.DMOSS_DEVICE_PORT || '22', 10),
    keyPath: process.env.DMOSS_DEVICE_KEY,
  };
}
