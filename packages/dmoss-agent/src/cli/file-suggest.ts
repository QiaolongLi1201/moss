import fs from 'node:fs';
import path from 'node:path';

/** A file/dir suggestion for the `@`-reference picker. @internal */
export interface FileSuggestion {
  /** Workspace-relative path; directories end with `/`. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  kind: 'file' | 'dir';
}

/** Directory names never walked into nor offered. @internal */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.moss',
  'dist',
  'build',
  '.cache',
  '.next',
  'coverage',
  '.DS_Store',
]);

const DEFAULT_LIMIT = 8;
const MAX_SCAN_ENTRIES = 4000;

/**
 * Subsequence-fuzzy rank of `query` against `candidate` (both already
 * lowercased). Lower is better: `[tier, span, firstIndex]`, tier 0 = exact,
 * 1 = prefix, 2 = subsequence. Returns null when the chars don't appear in
 * order. Mirrors the slash-menu fuzzy ranker so `@` and `/` feel identical.
 * @internal
 */
function fuzzyRank(candidate: string, query: string): [number, number, number] | null {
  if (query.length === 0) return [1, 0, 0];
  if (candidate === query) return [0, 0, 0];
  if (candidate.startsWith(query)) return [1, query.length, 0];
  let ci = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < query.length; qi += 1) {
    const ch = query[qi]!;
    let found = -1;
    while (ci < candidate.length) {
      if (candidate[ci] === ch) { found = ci; ci += 1; break; }
      ci += 1;
    }
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
  }
  return [2, last - first, first];
}

/**
 * Split a partial `@`-reference into the directory portion (already typed,
 * used to scope the scan) and the basename fragment to fuzzy-match. A trailing
 * slash means "list this directory", so the fragment is empty.
 * @internal
 */
function splitPartial(partial: string): { dir: string; frag: string } {
  const norm = partial.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  if (slash === -1) return { dir: '', frag: norm };
  return { dir: norm.slice(0, slash + 1), frag: norm.slice(slash + 1) };
}

/**
 * Suggest workspace files/dirs for an `@`-reference partial.
 *
 * Scans only the directory implied by `partial` (its leading dir portion),
 * never recursing — cheap and deterministic. Skips `node_modules`, `.git`,
 * dotted build/cache dirs, etc. Fuzzy-ranks the basename fragment (prefix-first),
 * caps results, and returns directories with a trailing `/` so the user can
 * drill in by pressing Tab/Enter again. Pure given (`partial`, `workspace`) and
 * the filesystem; no mutation, no process spawn.
 * @internal
 */
export function suggestWorkspaceFiles(
  partial: string,
  workspace: string,
  options: { limit?: number } = {},
): FileSuggestion[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const { dir, frag } = splitPartial(partial);
  // Resolve the scan directory inside the workspace; reject path escapes.
  const scanAbs = path.resolve(workspace, dir);
  const rootAbs = path.resolve(workspace);
  if (scanAbs !== rootAbs && !scanAbs.startsWith(rootAbs + path.sep)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > MAX_SCAN_ENTRIES) entries = entries.slice(0, MAX_SCAN_ENTRIES);

  const fragLower = frag.toLowerCase();
  const ranked: Array<{ suggestion: FileSuggestion; rank: [number, number, number]; name: string }> = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') && !fragLower.startsWith('.')) continue; // hide dotfiles unless explicitly typed
    const isDir = entry.isDirectory();
    if (isDir && SKIP_DIRS.has(name)) continue;
    if (!isDir && !entry.isFile()) continue; // skip sockets/fifos/symlink-to-nothing
    const rank = fuzzyRank(name.toLowerCase(), fragLower);
    if (!rank) continue;
    const relRaw = path.posix.join(dir.replace(/\\/g, '/'), name);
    const rel = isDir ? `${relRaw}/` : relRaw;
    const abs = path.join(scanAbs, name);
    ranked.push({ suggestion: { rel, abs, kind: isDir ? 'dir' : 'file' }, rank, name });
  }

  ranked.sort((a, b) =>
    a.rank[0] - b.rank[0]
    || a.rank[1] - b.rank[1]
    || a.rank[2] - b.rank[2]
    // Directories first within the same rank (so you can drill), then alpha.
    || (a.suggestion.kind === b.suggestion.kind ? 0 : a.suggestion.kind === 'dir' ? -1 : 1)
    || a.name.localeCompare(b.name));

  return ranked.slice(0, limit).map((entry) => entry.suggestion);
}

/**
 * Detect an `@`-reference being typed immediately before `cursor`.
 *
 * Matches `@` that starts a token (preceded by start-of-string or whitespace)
 * with no whitespace between it and the cursor. Returns the partial path (text
 * after `@`) and the index of the `@` so the caller can replace the token.
 * Returns null when the cursor isn't inside an `@`-token. Pure.
 * @internal
 */
export function detectAtReference(
  value: string,
  cursor: number,
): { partial: string; start: number } | null {
  const before = value.slice(0, cursor);
  // `@` must start a token: preceded by start-of-line or whitespace; the run
  // after it must contain no whitespace (a path fragment).
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const partial = match[1] ?? '';
  const start = cursor - partial.length - 1; // index of '@'
  return { partial, start };
}

/**
 * Extract `@path` reference tokens from submitted prompt text. A token is `@`
 * at start-of-string or after whitespace, followed by a non-whitespace path,
 * with any trailing `/` (directory) trimmed. Deduplicates, preserves order.
 * Pure — the caller resolves paths against the workspace. @internal
 */
export function parseAtReferences(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@(\S+)/g;
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? '').replace(/\/+$/, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}
