import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Detect the actual image type from file magic bytes. Returns the real MIME
 * (which wins over the extension-implied one) or null when the bytes are not
 * a supported image. @internal exported for tests.
 */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

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
  if (/^file:\/\//i.test(expanded)) return path.resolve(fileURLToPath(expanded));
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

  const trimmed = input.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === '\\') {
      const next = trimmed[i + 1];
      const canEscape = quote
        ? next === quote || next === '\\'
        : next === '"' || next === "'" || next === '\\' || (next !== undefined && /\s/.test(next));
      if (canEscape && next !== undefined) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
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
      if (stat.size === 0) {
        warnings.push(`Image attachment is empty (0 bytes), not attached: ${label}`);
        continue;
      }
      if (stat.size > MAX_IMAGE_BYTES) {
        warnings.push(`Image attachment is too large (${formatBytes(stat.size)} > ${formatBytes(MAX_IMAGE_BYTES)}): ${label}`);
        continue;
      }
      const buffer = fs.readFileSync(absPath);
      // Verify the bytes actually are an image before claiming "attached" —
      // a renamed/corrupt/truncated file would otherwise be silently sent to
      // the model as a broken image block.
      const detectedMime = detectImageMime(buffer);
      if (!detectedMime) {
        warnings.push(`Attachment has an image extension but not a valid image signature (corrupt or mislabeled), not attached: ${label}`);
        continue;
      }
      const data = buffer.toString('base64');
      attachments.push({ index, kind: 'image', path: absPath, label, filename, mimeType: detectedMime, bytes: stat.size });
      blocks.push({ type: 'text', text: attachmentTextHeader('Image', index, label) });
      blocks.push({ type: 'image', data, mimeType: detectedMime, filename });
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
