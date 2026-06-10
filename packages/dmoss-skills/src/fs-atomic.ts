/**
 * Atomic file write — write to a unique temp file then rename.
 *
 * On POSIX systems `rename(2)` within the same directory is atomic: the
 * target either has the old content or the new content, never a partial
 * write. The temp name embeds pid + a random token so two concurrent
 * writers (e.g. two agents learning into the same workspace) never
 * interleave writes into the SAME temp file; last rename wins with each
 * candidate file staying internally consistent.
 *
 * On failure the temp file is removed best-effort so the candidates
 * directory does not accumulate `.tmp` litter.
 *
 * @internal
 */

import fs from "node:fs";
import path from "node:path";

/**
 * DESIGN INTENT — deliberate process-wide, per-target write chain:
 * Windows can return EPERM when several temp files concurrently rename over
 * the same destination. The chain only serializes writes to the exact same
 * resolved target path; different files remain independent. If a write fails,
 * the next queued writer still gets a chance to replace the file.
 */
const targetWriteChains = new Map<string, Promise<void>>();

export async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const resolved = path.resolve(filePath);
  const previous = targetWriteChains.get(resolved) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeAtomically(resolved, data));
  targetWriteChains.set(resolved, current);
  try {
    await current;
  } finally {
    if (targetWriteChains.get(resolved) === current) targetWriteChains.delete(resolved);
  }
}

async function writeAtomically(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.promises.rm(tmpPath, { force: true });
    } catch {
      // best-effort cleanup; the original error matters more
    }
    throw err;
  }
}
