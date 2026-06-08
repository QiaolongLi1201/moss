import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatOptions } from '../core/agent/dmoss-agent-types.js';

export type PromptAttachmentBlock = NonNullable<ChatOptions['attachments']>[number];

export interface PreparedPromptAttachment {
  index: number;
  kind: 'image' | 'file';
  path: string;
  label: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

export interface PreparePromptAttachmentsOptions {
  cwd?: string;
  startIndex?: number;
}

export interface PreparePromptAttachmentsResult {
  attachments: PreparedPromptAttachment[];
  blocks: PromptAttachmentBlock[];
  warnings: string[];
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cmake',
  '.conf',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveAttachmentPath(value: string, cwd: string): string {
  const expanded = expandHome(value.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeLabel(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(absPath);
}

function isProbablyTextFile(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const fd = fs.openSync(absPath, 'r');
  try {
    const sample = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    if (bytesRead === 0) return true;
    const slice = sample.subarray(0, bytesRead);
    if (slice.includes(0)) return false;
    let control = 0;
    for (const byte of slice) {
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control += 1;
    }
    return control / Math.max(1, bytesRead) < 0.05;
  } finally {
    fs.closeSync(fd);
  }
}

function attachmentTextHeader(kind: 'Image' | 'File', index: number, label: string): string {
  return `[${kind} #${index}: ${label}]`;
}

export function parseAttachArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (current) out.push(current);
  return out;
}

export function preparePromptAttachments(
  values: string[],
  options: PreparePromptAttachmentsOptions = {},
): PreparePromptAttachmentsResult {
  const cwd = options.cwd ?? process.cwd();
  const attachments: PreparedPromptAttachment[] = [];
  const blocks: PromptAttachmentBlock[] = [];
  const warnings: string[] = [];
  let nextIndex = Math.max(1, options.startIndex ?? 1);

  for (const raw of values) {
    const absPath = resolveAttachmentPath(raw, cwd);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      warnings.push(`Attachment not found: ${raw} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`Attachment is not a file: ${raw}`);
      continue;
    }

    const ext = path.extname(absPath).toLowerCase();
    const imageMime = IMAGE_MIME_BY_EXT[ext];
    const filename = path.basename(absPath);
    const label = relativeLabel(absPath, cwd);
    const index = nextIndex;

    if (imageMime) {
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`Image attachment is too large (${formatBytes(stat.size)} > ${formatBytes(MAX_IMAGE_BYTES)}): ${label}`);
        continue;
      }
      const data = fs.readFileSync(absPath).toString('base64');
      attachments.push({ index, kind: 'image', path: absPath, label, filename, mimeType: imageMime, bytes: stat.size });
      blocks.push({ type: 'text', text: attachmentTextHeader('Image', index, label) });
      blocks.push({ type: 'image', data, mimeType: imageMime, filename });
      nextIndex += 1;
      continue;
    }

    if (!isProbablyTextFile(absPath)) {
      warnings.push(`Unsupported attachment: ${label}. Images and text files are supported in the TUI.`);
      continue;
    }
    if (stat.size > MAX_TEXT_BYTES) {
      warnings.push(`Text attachment is too large (${formatBytes(stat.size)} > ${formatBytes(MAX_TEXT_BYTES)}): ${label}`);
      continue;
    }
    const text = fs.readFileSync(absPath, 'utf8');
    attachments.push({ index, kind: 'file', path: absPath, label, filename, mimeType: 'text/plain', bytes: stat.size });
    blocks.push({
      type: 'text',
      text: [
        attachmentTextHeader('File', index, label),
        '<attachment>',
        text,
        '</attachment>',
      ].join('\n'),
    });
    nextIndex += 1;
  }

  return { attachments, blocks, warnings };
}

export function renderPendingAttachmentSummary(attachments: PreparedPromptAttachment[]): string {
  if (attachments.length === 0) return 'No pending attachments.';
  return [
    `Pending attachments (${attachments.length})`,
    ...attachments.map((item) =>
      `  [${item.kind === 'image' ? 'Image' : 'File'} #${item.index}] ${item.label} · ${item.mimeType} · ${formatBytes(item.bytes)}`,
    ),
  ].join('\n');
}
