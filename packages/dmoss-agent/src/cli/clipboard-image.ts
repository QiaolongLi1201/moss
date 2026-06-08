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

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function execFile(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timeout.unref?.();
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
        resolve();
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

export async function prepareClipboardImageAttachment(options: {
  runtimeDir: string;
  cwd: string;
  startIndex?: number;
  saveClipboardImage?: (destPath: string) => Promise<void>;
}): Promise<PreparePromptAttachmentsResult> {
  const dir = path.join(options.runtimeDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destPath = path.join(dir, `clipboard-${timestampForFilename()}.png`);
  await (options.saveClipboardImage ?? saveClipboardImageToFile)(destPath);
  const prepared = preparePromptAttachments([destPath], {
    cwd: options.cwd,
    startIndex: options.startIndex,
  });
  if (prepared.attachments.length === 0) {
    try {
      fs.rmSync(destPath, { force: true });
    } catch {
      // Best effort cleanup for an unreadable clipboard artifact.
    }
  }
  return prepared;
}
