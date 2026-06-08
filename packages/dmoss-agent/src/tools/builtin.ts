/**
 * Built-in tools for D-Moss Agent.
 *
 * These tools provide baseline capabilities for any D-Moss agent instance.
 * Host applications can register additional tools for their specific use case.
 *
 * **Security note**: File tools enforce workspace sandbox boundaries using
 * `resolveSandboxPath` from `@rdk-moss/agent/safety`. The `exec` tool runs
 * commands within the workspace cwd but does NOT restrict command content —
 * hosts should use `AgentHooks.onBeforeToolExec` to enforce approval policies.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { runProcess, ProcessError } from '../utils/run-process.js';
import type { Tool } from '../core/tools/tool-types.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { createSubagentTool, fanOutSubagentsTool, subagentStatusTool, subagentStopTool } from './create-subagent.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import { backgroundExecTools } from './background-exec.js';
import { codeDiagnosticsTool } from './code-diagnostics.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { applyUpdateHunk, extractAddContent, parsePatch } from '../utils/apply-patch-core.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import micromatch from 'micromatch';

const IS_WIN = process.platform === 'win32';

function childEnv(_workspaceDir: string): Record<string, string> {
  return safeChildEnv({ LANG: process.env.LANG || 'en_US.UTF-8' });
}

async function safePath(inputPath: string, workspaceDir: string): Promise<string> {
  const { resolved } = await assertSandboxPath({
    filePath: inputPath,
    cwd: workspaceDir,
    root: workspaceDir,
  });
  return resolved;
}

// ── Read-before-edit / stale-write guard ──────────────────────────────────
// Maps a resolved absolute path to the on-disk mtimeMs observed the last time
// the agent read or wrote it, so write_file/edit_file can refuse to silently
// clobber a file that changed on disk since the agent last saw it (external
// editor, linter, concurrent session). Module-scoped because file identity is
// global, not session-scoped — a single map is correct and cheap.
const fileReadState = new Map<string, number>();

async function recordFileState(resolvedPath: string): Promise<void> {
  try {
    const st = await fs.stat(resolvedPath);
    fileReadState.set(resolvedPath, st.mtimeMs);
  } catch {
    /* file may not exist yet — nothing to record */
  }
}

/**
 * Returns an error string when `resolvedPath` was read earlier but has since
 * been modified on disk; otherwise null. Only trips when we have a prior read
 * AND the file shows a strictly newer mtime — never blocks first-touch writes
 * or brand-new files, keeping false positives near zero.
 */
async function staleWriteError(resolvedPath: string, displayPath: string): Promise<string | null> {
  const seen = fileReadState.get(resolvedPath);
  if (seen === undefined) return null;
  let current: number;
  try {
    current = (await fs.stat(resolvedPath)).mtimeMs;
  } catch {
    return null; // gone on disk — let the write/create proceed
  }
  if (current > seen + 1) {
    return (
      `File has been modified since you last read it: ${displayPath}. ` +
      `Another process (editor, linter, or a concurrent task) changed it on disk. ` +
      `Read it again to get the current contents before writing, so you do not overwrite those changes.`
    );
  }
  return null;
}

const LINE_NUMBER_WIDTH = 6;

/** Prefix each line with a right-aligned line number + tab, like `cat -n`. */
function withLineNumbers(text: string, startLine = 1): string {
  return text
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`)
    .join('\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Length-preserving normalization of smart/curly quotes to straight quotes.
 * Each replaced character is a single BMP code unit mapped to a single ASCII
 * quote, so offsets in the normalized string align 1:1 with the original —
 * letting edit_file tolerate a quote-style mismatch in `old_string` without
 * disturbing any other bytes when it splices the original content.
 */
function normalizeEditQuotes(s: string): string {
  return s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file within the workspace. ' +
    'For large files, pass `offset` (1-based start line) and/or `limit` (line count) to page through it. ' +
    'Each line is prefixed with a right-aligned line number and a tab for reference — these prefixes are NOT part of the file; never copy them into edit_file / write_file / apply_patch content.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      offset: { type: 'number', description: '1-based line number to start reading from (default: start of file)' },
      limit: { type: 'number', description: 'Maximum number of lines to read from `offset` (default: to end of file)' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    try {
      const filePath = await safePath(input.path, ctx.workspaceDir);
      const content = await fs.readFile(filePath, 'utf-8');
      await recordFileState(filePath);
      const hasRange = input.offset !== undefined || input.limit !== undefined;
      if (hasRange) {
        const lines = content.split('\n');
        const start = Math.max(1, Math.floor(Number(input.offset) || 1));
        const count =
          input.limit !== undefined ? Math.max(0, Math.floor(Number(input.limit))) : lines.length;
        const slice = lines.slice(start - 1, start - 1 + count);
        const end = Math.min(lines.length, start - 1 + count);
        let body = slice.join('\n');
        let note = '';
        if (body.length > 100_000) {
          note = `\n\n[... truncated range, total ${body.length} chars]`;
          body = body.slice(0, 100_000);
        }
        return `[lines ${start}-${end} of ${lines.length}]\n${withLineNumbers(body, start)}${note}`;
      }
      if (content.length > 100_000) {
        return (
          withLineNumbers(content.slice(0, 100_000)) +
          `\n\n[... truncated, total ${content.length} chars — pass offset/limit to page through the rest]`
        );
      }
      return withLineNumbers(content);
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
      const stale = await staleWriteError(filePath, String(input.path ?? ''));
      if (stale) return `Error: ${stale}`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, 'utf-8');
      await recordFileState(filePath);
      return `Successfully wrote ${input.content.length} chars to ${input.path}`;
    } catch (err) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Make a precise in-place edit by replacing an exact string in an existing file. ' +
    'Prefer this over write_file for modifying files — it changes only the matched text and leaves everything else untouched, which is safer and cheaper than rewriting the whole file.\n' +
    '- `old_string` must match the file EXACTLY, including whitespace and indentation, and must be UNIQUE. Include enough surrounding context to target a single location; if it matches more than once the edit is rejected unless `replace_all` is true.\n' +
    "- Never include read_file's line-number prefixes in `old_string` or `new_string`.\n" +
    '- Set `new_string` to "" to delete the matched text. To create a new file or replace an entire file, use write_file instead.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      old_string: {
        type: 'string',
        description: 'Exact text to replace — must be unique in the file unless replace_all is set',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text (use "" to delete the matched text)',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match (default false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    try {
      const displayPath = String(input.path ?? '');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (oldStr === '') {
        return 'Error: old_string is empty. Use write_file to create a new file or replace an entire file.';
      }
      if (oldStr === newStr) {
        return 'Error: old_string and new_string are identical — nothing to change.';
      }
      const filePath = await safePath(displayPath, ctx.workspaceDir);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return `Error: file does not exist: ${displayPath}. Use write_file to create it.`;
        }
        throw err;
      }
      const stale = await staleWriteError(filePath, displayPath);
      if (stale) return `Error: ${stale}`;
      // Locate the target. Exact match first; if that yields nothing, retry on
      // a length-preserving quote-normalized view (smart/curly ↔ straight) so a
      // pure quote-style mismatch in old_string doesn't force a re-read + retry.
      // The replacement always splices the ORIGINAL bytes at the matched offsets
      // (offsets align 1:1 because normalization preserves length).
      let needle = oldStr;
      let haystack = content;
      let fuzzy = false;
      let occurrences = countOccurrences(haystack, needle);
      if (occurrences === 0) {
        const normContent = normalizeEditQuotes(content);
        const normOld = normalizeEditQuotes(oldStr);
        if ((normContent !== content || normOld !== oldStr) && countOccurrences(normContent, normOld) > 0) {
          haystack = normContent;
          needle = normOld;
          occurrences = countOccurrences(haystack, needle);
          fuzzy = true;
        }
      }
      if (occurrences === 0) {
        return (
          `Error: old_string not found in ${displayPath}. ` +
          'The text must match the file exactly — including whitespace and indentation — and must not include ' +
          "read_file's line-number prefixes. Read the file and copy the target text verbatim."
        );
      }
      if (occurrences > 1 && !input.replace_all) {
        return (
          `Error: old_string is not unique in ${displayPath} (${occurrences} matches). ` +
          'Add more surrounding context to target a single location, or pass replace_all: true to replace every occurrence.'
        );
      }
      let updated = '';
      let pos = 0;
      for (;;) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) {
          updated += content.slice(pos);
          break;
        }
        updated += content.slice(pos, idx) + newStr;
        pos = idx + needle.length;
        if (!input.replace_all) {
          updated += content.slice(pos);
          break;
        }
      }
      await atomicWriteFile(filePath, updated);
      await recordFileState(filePath);
      const label = input.replace_all && occurrences > 1 ? `${occurrences} occurrences` : '1 occurrence';
      const fuzzyNote = fuzzy ? '; matched after normalizing quote characters' : '';
      return `Edited ${displayPath} (replaced ${label}${fuzzyNote}).`;
    } catch (err) {
      return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description:
    'Move or rename a file or directory within the workspace. ' +
    'Both paths are sandbox-checked; destination parent directories are created as needed.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Existing path relative to workspace root' },
      destination: { type: 'string', description: 'New path relative to workspace root' },
      overwrite: { type: 'boolean', description: 'Overwrite destination if it already exists (default false)' },
    },
    required: ['source', 'destination'],
  },
  async execute(input, ctx) {
    try {
      const src = await safePath(input.source, ctx.workspaceDir);
      const dest = await safePath(input.destination, ctx.workspaceDir);
      try {
        await fs.access(src);
      } catch {
        return `Error: source does not exist: ${input.source}`;
      }
      if (!input.overwrite) {
        try {
          await fs.access(dest);
          return `Error: destination already exists: ${input.destination} (pass overwrite=true to replace)`;
        } catch {
          // destination is free — proceed
        }
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return `Moved ${input.source} -> ${input.destination}`;
    } catch (err) {
      return `Error moving file: ${err instanceof Error ? err.message : String(err)}`;
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
    'On Windows, this is the host PC shell (not a remote device); prefer device_exec when SSH is configured.\n' +
    '- Prefer the dedicated tools over shell equivalents: read_file over `cat`, edit_file over `sed`, search_files over `find`, search_code over `grep`/`rg`. Reserve exec for real shell work: installing deps, running tests/builds, git operations.\n' +
    '- Use absolute paths and avoid `cd`; the working directory is already the workspace and does not persist between calls.\n' +
    '- For long-running or blocking processes (dev servers, watchers, log tails) use exec_background instead of exec — a foreground exec that never returns will time out.',
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
      const result = await runProcess(shell, {
        args: IS_WIN ? ['/c', input.command] : ['-c', input.command],
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: childEnv(ctx.workspaceDir),
        cwd: ctx.workspaceDir,
      });
      const STDERR_MAX = 4096;
      const stderrRaw = result.stderr.trim();
      const stderrFmt = stderrRaw
        ? (stderrRaw.length > STDERR_MAX
            ? `--- stderr (truncated ${stderrRaw.length}→${STDERR_MAX} chars) ---\n${stderrRaw.slice(0, STDERR_MAX)}`
            : `--- stderr ---\n${stderrRaw}`)
        : '';
      const outParts = [result.stdout.trim(), stderrFmt].filter(Boolean);
      return outParts.join('\n\n') || '(no output)';
    } catch (err) {
      if (err instanceof ProcessError) {
        const output = [err.stdout.trim(), err.stderr.trim()].filter(Boolean).join('\n');
        return `Command failed (exit ${err.exitCode}):\n${output || err.message}`;
      }
      throw err;
    }
  },
};

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Find files by glob pattern within the workspace. Prefer this over running `find`/`ls` through exec — ' +
    'it is sandbox-checked and returns clean paths.',
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
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const matchRelativePath = normalizedPattern.includes('/');
  const root = dir;

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
      } else {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        const target = matchRelativePath ? relPath : e.name;
        if (micromatch.isMatch(target, normalizedPattern, { dot: false, basename: false, nocase: true })) {
          results.push(full);
        }
      }
    }
  }

  await walk(dir);
  return results;
}

// removed: globToRegex replaced by micromatch

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
  description:
    'Search for a regex or text pattern within files in the workspace. Returns matching file paths and line excerpts. ' +
    'Prefer this over running `grep`/`rg` through exec when you need to locate code by content.',
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

interface PatchFileState {
  path: string;
  displayPath: string;
  originalExists: boolean;
  originalContent: string | null;
  nextContent?: string | null;
}

function containsNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function decodePatchTarget(bytes: Uint8Array, displayPath: string): string {
  if (containsNul(bytes)) throw new Error(`refusing to patch binary-looking file: ${displayPath}`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`refusing to patch non-UTF-8 file: ${displayPath}`);
  }
}

function dominantLineEnding(original: string): '\n' | '\r\n' | null {
  const crlf = original.match(/\r\n/g)?.length ?? 0;
  const loneLf = original.match(/(?<!\r)\n/g)?.length ?? 0;
  if (crlf > loneLf) return '\r\n';
  if (loneLf > crlf) return '\n';
  return null;
}

function restoreDominantLineEndings(content: string, original: string): string {
  return dominantLineEnding(original) === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply a structured patch within the workspace. Supports add, update, and delete hunks. ' +
    'All hunks are parsed and conflict-checked before files are touched; applied files are restored on execution failure.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Patch text using *** Begin Patch / *** End Patch format',
      },
    },
    required: ['patch'],
  },
  async execute(input, ctx) {
    const parsed = parsePatch(String(input.patch ?? ''));
    if (parsed.errors.length > 0) return `Patch rejected:\n${parsed.errors.join('\n')}`;
    if (parsed.hunks.length === 0) return 'Patch rejected: no hunks found.';

    const states = new Map<string, PatchFileState>();

    const loadState = async (displayPath: string, filePath: string): Promise<PatchFileState> => {
      const existing = states.get(filePath);
      if (existing) return existing;
      try {
        const bytes = await fs.readFile(filePath);
        const state: PatchFileState = {
          path: filePath,
          displayPath,
          originalExists: true,
          originalContent: decodePatchTarget(bytes, displayPath),
        };
        states.set(filePath, state);
        return state;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const state: PatchFileState = {
          path: filePath,
          displayPath,
          originalExists: false,
          originalContent: null,
        };
        states.set(filePath, state);
        return state;
      }
    };

    try {
      for (const hunk of parsed.hunks) {
        const filePath = await safePath(hunk.path, ctx.workspaceDir);
        const state = await loadState(hunk.path, filePath);

        if (hunk.type === 'add') {
          if (state.originalExists || state.nextContent !== undefined) {
            return `Patch rejected: add target already exists: ${hunk.path}`;
          }
          const content = extractAddContent(hunk);
          state.nextContent = content;
          continue;
        }

        if (hunk.type === 'delete') {
          if (!state.originalExists && state.nextContent === undefined) {
            return `Patch rejected: delete target does not exist: ${hunk.path}`;
          }
          if (!state.originalExists && state.nextContent !== undefined) {
            return `Patch rejected: cannot delete file added in same patch: ${hunk.path}`;
          }
          if (state.nextContent === null) {
            return `Patch rejected: file already deleted in same patch: ${hunk.path}`;
          }
          state.nextContent = null;
          continue;
        }

        const previous = state.nextContent !== undefined ? state.nextContent : state.originalContent;
        if (!state.originalExists && state.nextContent === undefined) {
          return `Patch rejected: update target does not exist: ${hunk.path}`;
        }
        if (previous === null) return `Patch rejected: cannot update deleted file in same patch: ${hunk.path}`;
        const normalizedPrevious = previous.replace(/\r\n/g, '\n');
        const updated = applyUpdateHunk(normalizedPrevious, hunk);
        if (updated.error) return `Patch rejected for ${hunk.path}: ${updated.error}`;
        state.nextContent = restoreDominantLineEndings(updated.result, previous);
      }

      const changedStates = [...states.values()].filter((state) => state.nextContent !== undefined);
      const applied: PatchFileState[] = [];
      try {
        for (const state of changedStates) {
          const nextContent = state.nextContent;
          if (nextContent === undefined) continue;
          if (nextContent === null) {
            await fs.rm(state.path, { force: false });
          } else {
            await atomicWriteFile(state.path, nextContent);
          }
          applied.push(state);
        }
      } catch (err) {
        for (const state of applied.reverse()) {
          if (state.originalExists && state.originalContent !== null) {
            await atomicWriteFile(state.path, state.originalContent);
          } else {
            await fs.rm(state.path, { force: true });
          }
        }
        throw err;
      }

      const summary = changedStates.map((state) => {
        if (!state.originalExists && state.nextContent !== null) {
          return `add ${state.displayPath}`;
        }
        if (state.originalExists && state.nextContent === null) {
          return `delete ${state.displayPath}`;
        }
        if (state.originalExists && state.nextContent !== undefined) {
          return `update ${state.displayPath}`;
        } else {
          return `change ${state.displayPath}`;
        }
      });

      return `Patch applied:\n${summary.map((line) => `- ${line}`).join('\n')}`;
    } catch (err) {
      return `Patch failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const webFetchTool: Tool = createWebFetchTool();

export const webSearchTool: Tool = createWebSearchTool();

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
              const relPath = path.relative(dir, full);
              const ctxBefore = Math.max(0, i - 2);
              const ctxAfter = Math.min(lines.length - 1, i + 2);
              const block: string[] = [];
              for (let j = ctxBefore; j <= ctxAfter; j++) {
                const marker = j === i ? '>' : ' ';
                block.push(`${relPath}:${j + 1}:${marker} ${lines[j].slice(0, 200)}`);
              }
              results.push(block.join('\n'));
              i = ctxAfter;
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
  editFileTool,
  moveFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  webFetchTool,
  webSearchTool,
  applyPatchTool,
  codeDiagnosticsTool,
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
  ...backgroundExecTools,
];

/**
 * Register all built-in tools with a DmossAgent instance.
 */
export function registerBuiltinTools(agent: { tools: { register: (tool: Tool) => void } }): void {
  for (const tool of builtinTools) {
    agent.tools.register(tool);
  }
}
