/**
 * Device SSH Tools — connect to and execute commands on remote devices.
 *
 * These tools enable D-Moss to control physical hardware (embedded Linux
 * boards, edge devices, SBCs, etc.) over SSH.
 *
 * Configuration:
 *   DMOSS_DEVICE_HOST     — Device IP or hostname
 *   DMOSS_DEVICE_USER     — SSH username (default: root)
 *   DMOSS_DEVICE_PASSWORD  — SSH password
 *   DMOSS_DEVICE_PORT     — SSH port (default: 22)
 *   DMOSS_DEVICE_KEY      — Path to SSH private key (alternative to password)
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';
import { buildSshCommand, missingSshExecutableProcessError, shellEscape } from './ssh-utils.js';

export interface DeviceSshConfig {
  host: string;
  user?: string;
  password?: string;
  port?: number;
  keyPath?: string;
}

async function sshRun(
  config: DeviceSshConfig,
  remoteCmd: string,
  timeout: number,
  ctx?: ToolContext,
  maxBuffer?: number,
): Promise<string> {
  const sshBin = config.password ? 'sshpass' : 'ssh';
  const sshCmd = buildSshCommand(config, remoteCmd);
  const sshArgs = config.password ? ['-e', 'ssh', ...sshCmd] : sshCmd;
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(sshBin, {
      args: sshArgs,
      timeout,
      maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
      signal: ctx?.abortSignal,
      env: safeChildEnv(config.password ? { SSHPASS: config.password } : undefined),
    });
  } catch (err) {
    throw missingSshExecutableProcessError(err, sshBin) ?? err;
  }
  return result.stdout.trim() || '(no output)';
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
    async execute(input, ctx) {
      const timeout = Number(input.timeout_ms) || 30_000;
      const safetyCheck = isCommandDangerous(input.command);
      if (safetyCheck.blocked) {
        return `Command blocked: ${safetyCheck.reason}`;
      }
      try {
        return await sshRun(config, input.command, timeout, ctx);
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          return `Device command failed (exit ${err.exitCode}):\n${output || err.message}`;
        }
        throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and credentials',
          recoverable: true,
        });
      }
    },
  };

  const deviceInfo: Tool = {
    name: 'device_info',
    description: 'Get basic information about the connected device (hostname, OS, CPU, memory).',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
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
      try {
        return await sshRun(config, commands.join(' && '), 15_000, ctx, 1024 * 1024);
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          return `Failed to get device info (exit ${err.exitCode}):\n${output || err.message}`;
        }
        throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and device power',
          recoverable: true,
        });
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
    async execute(input, ctx) {
      try {
        const content = await sshRun(
          config,
          `cat ${shellEscape(input.path)}`,
          15_000,
          ctx,
          5 * 1024 * 1024,
        );
        if (content.length > 100_000) {
          return content.slice(0, 100_000) + '\n\n[... truncated]';
        }
        return content || '(empty file)';
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          return `Failed to read ${input.path} (exit ${err.exitCode}):\n${output || err.message}`;
        }
        throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and file path',
          recoverable: true,
        });
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
    async execute(input, ctx) {
      const dir = input.path || '/home';
      try {
        return await sshRun(config, `ls -la ${shellEscape(dir)}`, 10_000, ctx);
      } catch (err) {
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          return `Failed to list ${dir} (exit ${err.exitCode}):\n${output || err.message}`;
        }
        throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check SSH connectivity and directory path',
          recoverable: true,
        });
      }
    },
  };

  return [deviceExec, deviceInfo, deviceFileRead, deviceFileList];
}

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
