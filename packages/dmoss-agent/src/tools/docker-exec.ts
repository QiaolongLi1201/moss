/**
 * Docker execution backend — run commands inside a Docker container
 * instead of the host machine. Provides stronger isolation than
 * the default local exec tool.
 *
 * Usage:
 *   Set DMOSS_EXEC_BACKEND=docker to enable.
 *   Optionally set DMOSS_DOCKER_IMAGE (default: node:20-slim).
 *
 * The workspace directory is mounted as /workspace inside the container.
 *
 * Security: the spawned `docker` CLI subprocess receives a sanitized
 * environment via `safeChildEnv()` so host secrets (API keys, tokens,
 * AWS credentials, DATABASE_URL, etc.) are not exposed to docker
 * credential helpers, plugins, or any future `-e` forwarding.
 */

import type { Tool } from '../core/tools/tool-types.js';
import {
  runProcess,
  ProcessError,
  type RunProcessOptions,
  type RunProcessResult,
} from '../utils/run-process.js';
import { wrapAsDmoss, ErrorCode } from '../errors.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

const IS_WIN = process.platform === 'win32';

export interface DockerExecConfig {
  image?: string;
  workspaceDir: string;
  timeoutMs?: number;
  /**
   * Internal test seam: override how the docker CLI is invoked. Production
   * callers must leave this undefined so the real `runProcess` is used.
   */
  runProcessImpl?: (cmd: string, opts: RunProcessOptions) => Promise<RunProcessResult>;
}

async function isDockerAvailable(
  runner: (cmd: string, opts: RunProcessOptions) => Promise<RunProcessResult>,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runner('docker', {
      args: ['info'],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      signal,
      env: safeChildEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

export function createDockerExecTool(config: DockerExecConfig): Tool {
  const image = config.image || 'node:20-slim';
  const timeout = config.timeoutMs || 30_000;
  const runner = config.runProcessImpl ?? runProcess;

  return {
    name: 'exec',
    description: `Execute a shell command inside a Docker container (${image}). The workspace is mounted at /workspace. Provides stronger isolation than local execution.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute inside the container' },
        timeout_ms: { type: 'number', description: `Timeout in milliseconds (default: ${timeout})` },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const timeoutMs = Number(input.timeout_ms) || timeout;
      const workDir = ctx.workspaceDir || config.workspaceDir;

      if (!(await isDockerAvailable(runner, ctx.abortSignal))) {
        return 'Error: Docker is not available. Install Docker or set DMOSS_EXEC_BACKEND=local.';
      }

      const mountPath = IS_WIN
        ? workDir.replace(/\\/g, '/')
        : workDir;

      try {
        const result = await runner('docker', {
          args: [
            'run', '--rm',
            '-v', `${mountPath}:/workspace`,
            '-w', '/workspace',
            '--network', 'none',
            '--memory', '512m',
            '--cpus', '1',
            image,
            '/bin/sh', '-c', String(input.command),
          ],
          timeout: timeoutMs + 10_000,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.abortSignal,
          env: safeChildEnv(),
        });
        return result.stdout.trim() || '(no output)';
      } catch (err) {
        if (err instanceof ProcessError) {
          const stderr = err.stderr.trim();
          const stdout = err.stdout.trim();
          const output = [stdout, stderr].filter(Boolean).join('\n');
          return `Docker exec failed (exit ${err.exitCode}):\n${output || err.message}`;
        }
        throw wrapAsDmoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check Docker daemon status and image availability',
          recoverable: true,
        });
      }
    },
  };
}
