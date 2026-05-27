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
import type { Tool } from '../core/tools/tool-types.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { createSubagentTool } from './create-subagent.js';

const IS_WIN = process.platform === 'win32';

/** Block dangerous env vars from leaking to child processes. */
const DANGEROUS_ENV_KEYS = new Set([
  'SSHPASS', 'DMOSS_DEVICE_PASSWORD', 'DMOSS_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'AZURE_API_KEY', 'HF_TOKEN',
]);

function childEnv(_workspaceDir: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' };
  for (const key of DANGEROUS_ENV_KEYS) delete env[key];
  return env;
}

async function safePath(inputPath: string, workspaceDir: string): Promise<string> {
  const { resolved } = await assertSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file within the workspace.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    try {
      const filePath = await safePath(input.path, ctx.workspaceDir);
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
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
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
      const filePath = await safePath(input.path, ctx.workspaceDir);
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
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to workspace root (default: root)' },
    },
  },
  async execute(input, ctx) {
    try {
      const dirPath = await safePath(input.path || '.', ctx.workspaceDir);
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
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary: 'Host must enforce approval via AgentHooks.onBeforeToolExec. Do not allow unattended exec without explicit user consent.',
  },
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
    const safetyCheck = isCommandDangerous(input.command);
    if (safetyCheck.blocked) {
      return `Command blocked: ${safetyCheck.reason}`;
    }
    try {
      const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
      const result = execSync(input.command, {
        cwd: ctx.workspaceDir,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        shell,
        env: childEnv(ctx.workspaceDir),
      });
      return String(result).trim() || '(no output)';
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err) {
        const execErr = err as { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer; message: string };
        const stderr = execErr.stderr ? String(execErr.stderr).trim() : '';
        const stdout = execErr.stdout ? String(execErr.stdout).trim() : '';
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return `Command failed (exit ${execErr.status ?? 'unknown'}):\n${output || execErr.message}`;
      }
      throw err;
    }
  },
};

export const searchFilesTool: Tool = {
  name: 'search_files',
  description: 'Search for files matching a glob pattern within the workspace.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
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
      const searchDir = await safePath(input.path || '.', ctx.workspaceDir);
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
  // Guard against ReDoS: cap wildcard count and use non-backtracking alternation
  const starCount = (pattern.match(/\*/g) || []).length;
  if (starCount > 20) {
    // Fall back to literal match for pathological patterns
    return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')        // temp placeholder for **
    .replace(/\*/g, '[^/]*')            // single * matches non-slash chars only (no backtrack)
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, '.*')           // ** matches anything
    .replace(/\?/g, '[^/]');            // ? matches single non-slash char
  return new RegExp(`^${escaped}$`, 'i');
}

/** Directories to skip during recursive searches. */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  '__pycache__', '.tox', '.venv', 'venv',
  '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out',
]);

/** Detect known ReDoS patterns: nested quantifiers, repeating alternations, excessive length. */
function isSafeRegex(pattern: string): boolean {
  // 检测嵌套量词: (x+)+, (x*)+, (x+)*, (x*)*
  if (/(\([^)]*[+*]\)[+*])/.test(pattern)) return false;
  // 检测交替重复: (x|y)*, (a|aa)*
  if (/(\([^)]*\|[^)]*\)[+*])/.test(pattern)) return false;
  // 限制总长度
  if (pattern.length > 500) return false;
  return true;
}

export const searchCodeTool: Tool = {
  name: 'search_code',
  description: 'Search for a regex or text pattern within files in the workspace. Returns matching file paths and line excerpts.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex or literal text to search for' },
      path: { type: 'string', description: 'Subdirectory to search within (defaults to workspace root)' },
      fileTypes: { type: 'string', description: 'Comma-separated extensions to include, e.g. ".ts,.js,.json"' },
      maxResults: { type: 'number', description: 'Max matching lines to return (default 50, max 200)' },
      maxFileSize: { type: 'number', description: 'Skip files larger than this in bytes (default 100KB)' },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const maxResults = Math.min(Number(input.maxResults) || 50, 200);
    const maxFileSize = Number(input.maxFileSize) || 100 * 1024;
    const extensions = input.fileTypes
      ? String(input.fileTypes).split(',').map((e) => e.trim().toLowerCase())
      : null;

    let regex: RegExp;
    try {
      if (!isSafeRegex(String(input.pattern))) {
        return 'Error: pattern rejected as potentially unsafe (ReDoS risk). Use a simpler pattern.';
      }
      regex = new RegExp(String(input.pattern), 'i');
    } catch (err) {
      return `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const searchDir = await safePath(input.path || '.', ctx.workspaceDir);
      const matches = await grepWalk(searchDir, regex, extensions, maxResults, maxFileSize, 30_000);
      if (matches.length === 0) return 'No matches found';
      return matches.join('\n');
    } catch (err) {
      return `Error searching code: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/**
 * Recursively walk directories and grep file contents for a regex pattern.
 * Respects extension filter, file size limit, result limit, and timeout.
 */
async function grepWalk(
  dir: string,
  regex: RegExp,
  extensions: string[] | null,
  limit: number,
  maxFileSize: number,
  timeoutMs: number,
): Promise<string[]> {
  const results: string[] = [];
  const deadline = Date.now() + timeoutMs;

  async function walk(d: string) {
    if (results.length >= limit || Date.now() > deadline) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= limit || Date.now() > deadline) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (extensions && !extensions.some((ext) => e.name.toLowerCase().endsWith(ext))) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > maxFileSize) continue;
          const content = await fs.readFile(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= limit) break;
            if (regex.test(lines[i])) {
              // filepath:linenum: excerpt (1-indexed line numbers)
              const relPath = path.relative(dir, full);
              const excerpt = lines[i].trim().slice(0, 200);
              results.push(`${relPath}:${i + 1}: ${excerpt}`);
            }
          }
        } catch {
          // Skip unreadable or binary files
        }
      }
    }
  }

  await walk(dir);
  return results;
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
  searchCodeTool,
  createSubagentTool,
];

/**
 * Register all built-in tools with a DmossAgent instance.
 */
export function registerBuiltinTools(agent: { tools: { register: (tool: Tool) => void } }): void {
  for (const tool of builtinTools) {
    agent.tools.register(tool);
  }
}
