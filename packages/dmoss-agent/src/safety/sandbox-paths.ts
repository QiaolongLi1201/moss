/**
 * Sandbox path resolution — ensures file operations stay within allowed directory roots.
 *
 * Prevents path traversal attacks and symlink escapes by resolving paths
 * against a primary root and optional extra roots.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DmossError, ErrorCode } from '../errors.js';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, ' ');
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === '~') {
    return os.homedir();
  }
  if (normalized.startsWith('~/')) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

function shortPath(value: string): string {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}

async function assertNoSymlink(relative: string, root: string): Promise<void> {
  if (!relative) {
    return;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new DmossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `Path contains symlink: ${current}`,
        });
      }
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }
}

async function assertRootIsNotSymlink(root: string): Promise<void> {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) {
      throw new DmossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `Sandbox root is a symlink: ${root}`,
      });
    }
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

function isUnderRoot(resolved: string, root: string): { ok: boolean; relative: string } {
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === '') {
    return { ok: true, relative: '' };
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, relative };
  }
  return { ok: true, relative };
}

export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  extraRoots?: string[];
}): { resolved: string; relative: string; matchedRoot: string } {
  const resolved = resolveToCwd(params.filePath, params.cwd);
  const primaryCheck = isUnderRoot(resolved, params.root);
  if (primaryCheck.ok) {
    return { resolved, relative: primaryCheck.relative, matchedRoot: path.resolve(params.root) };
  }
  if (params.extraRoots) {
    for (const extra of params.extraRoots) {
      const check = isUnderRoot(resolved, extra);
      if (check.ok) {
        return { resolved, relative: check.relative, matchedRoot: path.resolve(extra) };
      }
    }
  }
  throw new DmossError({
    code: ErrorCode.TOOL_NOT_ALLOWED,
    message: `Path escapes workspace (${shortPath(path.resolve(params.root))}): ${params.filePath}`,
  });
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  extraRoots?: string[];
}): Promise<{ resolved: string; relative: string }> {
  const resolved = resolveSandboxPath(params);
  await assertRootIsNotSymlink(resolved.matchedRoot);
  await assertNoSymlink(resolved.relative, resolved.matchedRoot);

  // TOCTOU mitigation: re-verify via realpath that no symlink was inserted
  // between the lstat walk above and the caller's subsequent file operation.
  // Both sides must be realpath-resolved: on macOS /var → /private/var etc.
  try {
    const realResolved = await fs.realpath(resolved.resolved);
    const realRoot = await fs.realpath(resolved.matchedRoot);
    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      throw new DmossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `path escapes sandbox after realpath resolution: ${params.filePath}`,
      });
    }
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== 'ENOENT') throw err;
    // ENOENT is acceptable — the file may not exist yet.
  }

  return { resolved: resolved.resolved, relative: resolved.relative };
}
