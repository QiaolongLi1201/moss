/**
 * Atomic file write — write to a temporary file then rename.
 *
 * On POSIX systems, `rename(2)` within the same filesystem is atomic:
 * the target path either has the old content or the new content, never
 * a partial write. This protects against data loss if the process crashes
 * mid-write (the original file is untouched until the rename completes).
 *
 * Caveats:
 * - The temp file and target must be on the same filesystem (guaranteed
 *   when they share a directory).
 * - On Windows, `fs.rename` is not strictly atomic but still safer than
 *   a direct `writeFile` that truncates before writing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Atomically write `content` to `filePath` via a write-to-temp-then-rename
 * strategy. The temp file is created in the same directory as the target
 * to ensure same-filesystem rename semantics.
 *
 * If the write or rename fails, the original file (if any) is left intact.
 * The temp file is cleaned up on failure.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const tmpPath = `${resolved}.tmp`;

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, resolved);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    // If cleanup itself fails, swallow — the original error is more important.
    try {
      await fs.rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}
