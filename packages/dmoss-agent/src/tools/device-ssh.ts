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
import { isCommandDangerous } from '../safety/channel-safety.js';
import { ProcessError } from '../utils/run-process.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';
import { buildSshCommand, missingSshExecutableProcessError, runSsh, sshBinFor, shellEscape } from './ssh-utils.js';

export interface DeviceSshConfig {
  host: string;
  user?: string;
  password?: string;
  port?: number;
  keyPath?: string;
  /**
   * DDS domain the robot's ROS2 graph lives on. When set, the ros2_* tools
   * export ROS_DOMAIN_ID before each command — without it, a robot on a
   * non-default domain silently returns empty topic/node/service lists.
   * @beta
   */
  rosDomainId?: number;
}

async function sshRun(
  config: DeviceSshConfig,
  remoteCmd: string,
  timeout: number,
  ctx?: Pick<ToolContext, 'abortSignal'>,
  maxBuffer?: number,
): Promise<string> {
  const sshArgs = buildSshCommand(config, remoteCmd);
  let result: Awaited<ReturnType<typeof runSsh>>;
  try {
    result = await runSsh(config, sshArgs, {
      timeout,
      maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
      signal: ctx?.abortSignal,
    });
  } catch (err) {
    throw missingSshExecutableProcessError(err, sshBinFor(config)) ?? err;
  }
  return result.stdout.trim() || '(no output)';
}

/** Failure category so callers can give targeted, actionable guidance. */
export type DeviceSshProbeFailureKind =
  | 'auth'
  | 'refused'
  | 'unreachable'
  | 'dns'
  | 'missing-tool'
  | 'other';

export interface DeviceSshProbeResult {
  ok: boolean;
  /** Remote hostname when ok; human-readable failure reason when not. */
  detail: string;
  /** Set when ok is false. */
  kind?: DeviceSshProbeFailureKind;
}

function classifyProbeFailure(
  config: DeviceSshConfig,
  err: unknown,
): { kind: DeviceSshProbeFailureKind; message: string } {
  const target = `${config.user || 'root'}@${config.host}:${config.port || 22}`;
  if (err instanceof ProcessError) {
    const stderr = (err.stderr || '').trim();
    const text = stderr.toLowerCase();
    const tail = stderr.split('\n').slice(-3).join(' ').trim();
    if (text.includes('permission denied') || text.includes('authentication fail') || err.exitCode === 5) {
      return {
        kind: 'auth',
        message: `Authentication failed for ${target}. Pass --password <pw> or --key <path>, or set DMOSS_DEVICE_PASSWORD / DMOSS_DEVICE_KEY.`,
      };
    }
    if (text.includes('connection refused')) {
      return {
        kind: 'refused',
        message: `Connection refused on port ${config.port || 22} of ${config.host}. Check --port and that sshd is running on the board.`,
      };
    }
    if (
      text.includes('timed out') ||
      text.includes('no route to host') ||
      text.includes('host unreachable') ||
      text.includes('network is unreachable')
    ) {
      return {
        kind: 'unreachable',
        message: `Host ${config.host} is unreachable (${tail || 'connection timed out'}). Check the IP and that the board is on the same network.`,
      };
    }
    if (text.includes('could not resolve') || text.includes('not known')) {
      return {
        kind: 'dns',
        message: `Cannot resolve hostname ${config.host}. Check the spelling or use the board IP.`,
      };
    }
    if (err.exitCode === 127) {
      return { kind: 'missing-tool', message: tail || 'SSH executable not found.' };
    }
    return {
      kind: 'other',
      message: `SSH probe failed (exit ${err.exitCode})${tail ? `: ${tail}` : ''}. Target: ${target}.`,
    };
  }
  return {
    kind: 'other',
    message: `SSH probe failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/**
 * Verify that the device is actually reachable and credentials work by
 * running a trivial remote command. Used by /connect before claiming success.
 *
 * @beta
 */
export async function probeDeviceSsh(
  config: DeviceSshConfig,
  options: { timeoutMs?: number; abortSignal?: AbortSignal } = {},
): Promise<DeviceSshProbeResult> {
  try {
    const hostname = await sshRun(
      config,
      'uname -n 2>/dev/null || hostname',
      options.timeoutMs ?? 15_000,
      { abortSignal: options.abortSignal },
      64 * 1024,
    );
    return { ok: true, detail: hostname === '(no output)' ? config.host : hostname.split('\n')[0].trim() };
  } catch (err) {
    const classified = classifyProbeFailure(config, err);
    return { ok: false, detail: classified.message, kind: classified.kind };
  }
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
        if (err instanceof ProcessError && err.timedOut) {
          throw new Error(
            `Device command timed out after ${Math.round(timeout / 1000)}s. ` +
              `Raise the limit with timeout_ms (e.g. timeout_ms: ${timeout * 4}) for long commands like colcon build or apt install.`,
          );
        }
        if (err instanceof ProcessError) {
          const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
          throw new Error(`Device command failed (exit ${err.exitCode}):\n${output || err.message}`);
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
          throw new Error(`Failed to get device info (exit ${err.exitCode}):\n${output || err.message}`);
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
          throw new Error(`Failed to read ${input.path} (exit ${err.exitCode}):\n${output || err.message}`);
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
          throw new Error(`Failed to list ${dir} (exit ${err.exitCode}):\n${output || err.message}`);
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

  const rawDomain = process.env.DMOSS_ROS_DOMAIN_ID;
  const parsedDomain = rawDomain !== undefined ? Number.parseInt(rawDomain, 10) : NaN;
  return {
    host,
    user: process.env.DMOSS_DEVICE_USER || 'root',
    password: process.env.DMOSS_DEVICE_PASSWORD,
    port: parseInt(process.env.DMOSS_DEVICE_PORT || '22', 10),
    keyPath: process.env.DMOSS_DEVICE_KEY,
    ...(Number.isInteger(parsedDomain) && parsedDomain >= 0 ? { rosDomainId: parsedDomain } : {}),
  };
}
