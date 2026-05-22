/**
 * Built-in tools for D-Moss Agent.
 *
 * These tools provide baseline capabilities for any D-Moss agent instance.
 * Host applications can register additional tools for their specific use case.
 *
 * **Security note**: File tools enforce workspace sandbox boundaries using
 * `resolveSandboxPath` from `@dmoss/agent/safety`. The `exec` tool runs
 * commands within the workspace cwd but does NOT restrict command content —
 * hosts should use `AgentHooks.onBeforeToolExec` to enforce approval policies.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Tool } from '../core/tool-types.js';
import { resolveSandboxPath } from '../safety/sandbox-paths.js';

const IS_WIN = process.platform === 'win32';

function safePath(inputPath: string, workspaceDir: string): string {
  const { resolved } = resolveSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file within the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    try {
      const filePath = safePath(input.path, ctx.workspaceDir);
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.length > 100_000) {
        return content.slice(0, 100_000) + `\n\n[... truncated, total ${content.length} chars]`;
      }
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file within the workspace. Creates parent directories if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    try {
      const filePath = safePath(input.path, ctx.workspaceDir);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, 'utf-8');
      return `Successfully wrote ${input.content.length} chars to ${input.path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories within the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace root (default: root)' },
    },
  },
  async execute(input, ctx) {
    try {
      const dirPath = safePath(input.path || '.', ctx.workspaceDir);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? '/' : '';
        return `${e.name}${suffix}`;
      });
      return lines.join('\n') || '(empty directory)';
    } catch (err) {
      return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const WIN_POSIX_HINT =
  'On Windows the local shell is cmd/PowerShell: Unix-only utilities (e.g. uname, grep without Git) are unavailable. ' +
  'Use PowerShell equivalents, read workspace files, or use device_* tools when SSH to a Linux board is configured.';

export const execTool: Tool = {
  name: 'exec',
  description:
    'Execute a shell command in the workspace directory. Returns stdout + stderr. Commands run with cwd set to the workspace. ' +
    'On Windows, this is the host PC shell (not the RDK board); prefer device_exec when SSH is configured.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    const timeoutMs = Number(input.timeout_ms) || 30_000;
    if (IS_WIN && /\buname\b/i.test(input.command)) {
      return (
        `Command skipped: uname is not available on Windows cmd.\n${WIN_POSIX_HINT}`
      );
    }
    try {
      const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
      const result = execSync(input.command, {
        cwd: ctx.workspaceDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        shell,
        env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' },
      });
      return String(result).trim() || '(no output)';
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr).trim() : '';
      const stdout = err.stdout ? String(err.stdout).trim() : '';
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return `Command failed (exit ${err.status ?? 'unknown'}):\n${output || err.message}`;
    }
  },
};

export const searchFilesTool: Tool = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern within the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "*.py", "src/**/*.ts")' },
      path: { type: 'string', description: 'Directory to search in relative to workspace (default: root)' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    try {
      const searchDir = safePath(input.path || '.', ctx.workspaceDir);
      const results = await walkMatch(searchDir, input.pattern, 100);
      return results.length > 0 ? results.join('\n') : 'No files found';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

async function walkMatch(dir: string, pattern: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const re = globToRegex(pattern);

  async function walk(d: string) {
    if (results.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await walk(full);
      } else if (re.test(e.name)) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * All built-in tools for D-Moss Agent.
 * Register these with `agent.tools.register(tool)` for each tool,
 * or use `registerBuiltinTools(agent)` for convenience.
 */
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
];

/**
 * Register all built-in tools with a DmossAgent instance.
 */
export function registerBuiltinTools(agent: { tools: { register: (tool: Tool) => void } }): void {
  for (const tool of builtinTools) {
    agent.tools.register(tool);
  }
}
