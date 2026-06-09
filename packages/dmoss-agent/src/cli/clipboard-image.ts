import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  preparePromptAttachments,
  type PreparePromptAttachmentsResult,
} from './attachments.js';

const APPLESCRIPT_SAVE_PNG = `
on run argv
  set outPath to item 1 of argv
  try
    set pngData to the clipboard as «class PNGf»
  on error
    error "clipboard does not contain a PNG image"
  end try
  set outFile to open for access (POSIX file outPath) with write permission
  try
    set eof outFile to 0
    write pngData to outFile
  on error errMsg number errNum
    try
      close access outFile
    end try
    error errMsg number errNum
  end try
  close access outFile
end run
`.trim();

const APPLESCRIPT_READ_CLIPBOARD_PATHS = `
on appendPath(outList, itemValue)
  try
    set end of outList to POSIX path of (itemValue as alias)
  end try
  return outList
end appendPath

on run
  set out to {}
  try
    set fileItems to the clipboard as «class furl»
    if class of fileItems is list then
      repeat with f in fileItems
        set out to appendPath(out, f)
      end repeat
    else
      set out to appendPath(out, fileItems)
    end if
  end try

  if (count of out) > 0 then
    set AppleScript's text item delimiters to linefeed
    return out as text
  end if

  try
    return the clipboard as text
  on error
    return ""
  end try
end run
`.trim();

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function execFile(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

export async function saveClipboardImageToFile(destPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('clipboard image paste is currently supported on macOS terminals only');
  }
  await execFile('osascript', ['-e', APPLESCRIPT_SAVE_PNG, destPath], 5000);
}

export async function readClipboardAttachmentPaths(): Promise<string[]> {
  if (process.platform !== 'darwin') {
    throw new Error('clipboard file paste is currently supported on macOS terminals only');
  }
  const output = await execFile('osascript', ['-e', APPLESCRIPT_READ_CLIPBOARD_PATHS], 5000);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function prepareClipboardAttachment(options: {
  runtimeDir: string;
  cwd: string;
  startIndex?: number;
  saveClipboardImage?: (destPath: string) => Promise<void>;
  readClipboardPaths?: () => Promise<string[]>;
}): Promise<PreparePromptAttachmentsResult> {
  const dir = path.join(options.runtimeDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destPath = path.join(dir, `clipboard-${timestampForFilename()}.png`);

  try {
    await (options.saveClipboardImage ?? saveClipboardImageToFile)(destPath);
    const prepared = preparePromptAttachments([destPath], {
      cwd: options.cwd,
      startIndex: options.startIndex,
    });
    if (prepared.attachments.length > 0) return prepared;
  } catch {
    // Fall through to file/path clipboard handling below.
  }

  try {
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      // Best effort cleanup for an unreadable clipboard artifact.
    }
    const paths = await (options.readClipboardPaths ?? readClipboardAttachmentPaths)();
    if (paths.length > 0) {
      return preparePromptAttachments(paths, {
        cwd: options.cwd,
        startIndex: options.startIndex,
      });
    }
  } catch {
    // Throw the generic actionable error below.
  }

  throw new Error('clipboard does not contain a supported image, file, or file path');
}

export async function prepareClipboardImageAttachment(options: {
  runtimeDir: string;
  cwd: string;
  startIndex?: number;
  saveClipboardImage?: (destPath: string) => Promise<void>;
}): Promise<PreparePromptAttachmentsResult> {
  return prepareClipboardAttachment(options);
}
