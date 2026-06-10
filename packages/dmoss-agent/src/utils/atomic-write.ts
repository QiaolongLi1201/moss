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
 * DESIGN INTENT — deliberate process-wide, per-target write chain:
 * Windows can reject concurrent rename-over-existing-file operations with
 * EPERM. The chain only serializes writes to the exact same resolved target;
 * unrelated files still write concurrently, and a failed write does not poison
 * later queued writes.
 */
const targetWriteChains = new Map<string, Promise<void>>();

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
  const previous = targetWriteChains.get(resolved) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeAtomically(resolved, content));
  targetWriteChains.set(resolved, current);
  try {
    await current;
  } finally {
    if (targetWriteChains.get(resolved) === current) targetWriteChains.delete(resolved);
  }
}

async function writeAtomically(resolved: string, content: string): Promise<void> {
  const dir = path.dirname(resolved);
  // Unique temp name (pid + random token): two concurrent writers must never
  // interleave writes into the SAME temp file — with a fixed `.tmp` suffix the
  // second writer truncates the first writer's half-written temp, and the
  // rename can land a torn file. Unique names make each rename atomic on its
  // own; last rename wins with both contents internally consistent.
  const tmpPath = `${resolved}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;

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
