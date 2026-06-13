/**
 * Approval-card detail preview.
 *
 * At decision time the user previously saw only an action summary plus a
 * truncated input JSON. For the highest-stakes approvals that is not enough
 * to decide in one second:
 *  - file edits  → show the actual ± diff (write_file / edit_file / apply_patch)
 *  - device mutations → show exactly what will run on which board
 *
 * Pure functions; rendering/coloring stays in the TUI (lines starting with
 * "+" / "-" are colorized by ApprovalPromptLine).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export interface ApprovalDetailContext {
  workspaceDir?: string;
  device?: { host: string; user?: string; port?: number } | null;
}

const MAX_DETAIL_LINES = 18;
const MAX_DIFF_INPUT_LINES = 400;
const MAX_LINE_CHARS = 200;

function cleanLine(line: string): string {
  const stripped = Array.from(sanitizeSecrets(line))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || (code >= 32 && code !== 127);
    })
    .join('');
  return stripped.length > MAX_LINE_CHARS ? `${stripped.slice(0, MAX_LINE_CHARS - 1)}…` : stripped;
}

function capLines(lines: string[], max = MAX_DETAIL_LINES): string[] {
  if (lines.length <= max) return lines;
  const hidden = lines.length - (max - 1);
  return [...lines.slice(0, max - 1), `  … (+${hidden} more lines — Ctrl+O after approval shows full detail)`];
}

/** Minimal LCS line diff. Returns null when inputs are too large to diff cheaply. */
export function diffLinesForApproval(oldText: string, newText: string): string[] | null {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > MAX_DIFF_INPUT_LINES || b.length > MAX_DIFF_INPUT_LINES) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let contextRun = 0;
  const pushContextEllipsis = () => {
    if (contextRun > 0) {
      out.push(`  … (${contextRun} unchanged line${contextRun === 1 ? '' : 's'})`);
      contextRun = 0;
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      contextRun += 1;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushContextEllipsis();
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      pushContextEllipsis();
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  pushContextEllipsis();
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function editFileDetail(input: Record<string, unknown>): string[] | null {
  const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
  const newString = typeof input.new_string === 'string' ? input.new_string : undefined;
  if (oldString === undefined || newString === undefined) return null;
  const diff = diffLinesForApproval(oldString, newString);
  if (!diff) return null;
  if (diff.every((line) => line.startsWith('  …'))) return null;
  return diff;
}

function writeFileDetail(input: Record<string, unknown>, ctx: ApprovalDetailContext): string[] | null {
  const filePath = typeof input.path === 'string' ? input.path : undefined;
  const content = typeof input.content === 'string' ? input.content : undefined;
  if (!filePath || content === undefined) return null;
  let existing: string | null = null;
  if (ctx.workspaceDir) {
    try {
      const resolved = path.resolve(ctx.workspaceDir, filePath);
      // Preview only — never follow outside the workspace.
      if (resolved.startsWith(path.resolve(ctx.workspaceDir) + path.sep) || resolved === path.resolve(ctx.workspaceDir)) {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          existing = fs.readFileSync(resolved, 'utf8');
        }
      }
    } catch {
      existing = null;
    }
  }
  const newLines = content.split('\n');
  if (existing === null) {
    return [`new file: ${filePath} (${newLines.length} line${newLines.length === 1 ? '' : 's'})`, ...newLines.map((line) => `+ ${line}`)];
  }
  const diff = diffLinesForApproval(existing, content);
  if (!diff) {
    return [`overwrite: ${filePath} (${existing.split('\n').length} → ${newLines.length} lines; too large to diff inline)`];
  }
  if (diff.every((line) => line.startsWith('  …'))) return [`no content change: ${filePath}`];
  return [`overwrite: ${filePath}`, ...diff];
}

function applyPatchDetail(input: Record<string, unknown>): string[] | null {
  const patch = typeof input.patch === 'string' ? input.patch : undefined;
  if (!patch) return null;
  const body = patch
    .split('\n')
    .filter((line) => !/^\*\*\* (Begin|End) Patch/.test(line));
  return body.length ? body : null;
}

function deviceDetail(input: Record<string, unknown>, ctx: ApprovalDetailContext): string[] {
  const target = ctx.device
    ? `${ctx.device.user || 'root'}@${ctx.device.host}:${ctx.device.port || 22}`
    : 'connected device';
  const lines = [`Device action plan:`, `  target  ${target}`];
  const command = typeof input.command === 'string' ? input.command : undefined;
  if (command) lines.push(`  command ${command}`);
  const timeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
  if (timeout) lines.push(`  timeout ${Math.round(timeout / 1000)}s`);
  return lines;
}

/**
 * Detail lines for the approval card. Empty array = no extra detail (the
 * existing summary is enough).
 */
export function buildApprovalDetailLines(
  toolName: string,
  sideEffect: string,
  input: Record<string, unknown>,
  ctx: ApprovalDetailContext = {},
): string[] {
  let lines: string[] | null = null;
  if (sideEffect === 'device_mutation') {
    lines = deviceDetail(input, ctx);
  } else if (toolName === 'edit_file') {
    lines = editFileDetail(input);
  } else if (toolName === 'write_file') {
    lines = writeFileDetail(input, ctx);
  } else if (toolName === 'apply_patch') {
    lines = applyPatchDetail(input);
  }
  if (!lines || lines.length === 0) return [];
  return capLines(lines.map(cleanLine));
}
