import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DmossError, ErrorCode } from "../../errors.js";

type LockPayload = {
  pid: number;
  nonce: string;
  createdAt: string;
};

export interface SessionWriteLock {
  release: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.nonce !== "string") return null;
    if (typeof parsed.createdAt !== "string") return null;
    return { pid: parsed.pid, nonce: parsed.nonce, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function getLockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

async function tryCreateLock(
  lockPath: string,
): Promise<{ handle: fs.FileHandle; nonce: string } | null> {
  try {
    const nonce = crypto.randomUUID();
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify(
        { pid: process.pid, nonce, createdAt: new Date().toISOString() },
        null,
        2,
      ),
      "utf8",
    );
    return { handle, nonce };
  } catch (err) {
    if ((err as { code?: unknown }).code === "EEXIST") return null;
    throw err;
  }
}

function makeLockResult(
  handle: fs.FileHandle,
  lockPath: string,
  nonce: string,
): SessionWriteLock {
  const release = async () => {
    try {
      await handle.close();
    } catch {
      // already closed
    }
    // M3: Only unlink if we still own the lock (nonce hasn't been replaced).
    // If our scope outlived a heartbeat-based reclaim, don't clobber the new owner.
    try {
      const current = await readLockPayload(lockPath);
      if (current?.nonce === nonce) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // If we can't read, best-effort remove (might be already gone).
      await fs.rm(lockPath, { force: true });
    }
  };
  return { release, [Symbol.asyncDispose]: release };
}

export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<SessionWriteLock> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30 * 60 * 1000;
  const sessionFile = path.resolve(params.sessionFile);
  const lockPath = `${sessionFile}.lock`;
  const startedAt = Date.now();
  let attempt = 0;
  let lastSeenNonce: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    // Attempt atomic create-or-fail
    const created = await tryCreateLock(lockPath);
    if (created) {
      return makeLockResult(created.handle, lockPath, created.nonce);
    }

    // Lock file exists — assess whether it's stale
    const payload = await readLockPayload(lockPath);
    const ageMs = await getLockAgeMs(lockPath);

    if (!payload) {
      // Unreadable or corrupt lock file — reclaim
      lastSeenNonce = null;
      await fs.rm(lockPath, { force: true });
      continue;
    }

    const alive = isAlive(payload.pid);
    let stale = false;

    if (!alive) {
      // Process is gone — lock is stale
      stale = true;
    } else if (ageMs !== null && ageMs > staleMs) {
      // Lock exceeded maximum age by filesystem mtime — stale
      stale = true;
    } else if (lastSeenNonce !== null && payload.nonce !== lastSeenNonce) {
      // PID is alive but nonce changed since our last read → PID was reused
      // by a different process instance; the original lock holder is gone
      stale = true;
    }

    if (!stale) {
      // Lock is legitimately held by a live process with a consistent nonce
      lastSeenNonce = payload.nonce;
      const delay = Math.min(1000, 50 * attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    // Stale lock — compare-and-swap reclaim:
    // 1. Remember the stale nonce
    // 2. H1: Re-read just before rm to verify nonce hasn't been refreshed
    // 3. Remove the stale file
    // 4. Try wx (atomic create-or-fail)
    // 5. If wx fails, re-read: same nonce → retry, different nonce → back off
    const staleNonce = payload.nonce;

    // H1: Re-verify nonce hasn't been refreshed between stale-detection and rm.
    // This closes the TOCTOU window where the original holder could have
    // written a new heartbeat (e.g., clock skew, suspended VM waking up).
    const preRmPayload = await readLockPayload(lockPath);
    if (preRmPayload?.nonce !== staleNonce) {
      // Lock was refreshed or reclaimed — restart assessment.
      lastSeenNonce = preRmPayload?.nonce ?? null;
      const delay = Math.min(1000, 50 * attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    await fs.rm(lockPath, { force: true });

    const retry = await tryCreateLock(lockPath);
    if (retry) {
      return makeLockResult(retry.handle, lockPath, retry.nonce);
    }

    // wx failed — someone else created the lock between our rm and wx
    const newPayload = await readLockPayload(lockPath);
    if (newPayload?.nonce === staleNonce) {
      // Same stale nonce survived (rm didn't take effect) — retry immediately
      lastSeenNonce = staleNonce;
      continue;
    }

    // Different nonce → someone else won the race and acquired the lock
    lastSeenNonce = newPayload?.nonce ?? null;
    const delay = Math.min(1000, 50 * attempt);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // Timed out — collect diagnostics for the error message
  const finalPayload = await readLockPayload(lockPath);
  const finalAge = await getLockAgeMs(lockPath);
  const pid = finalPayload?.pid ?? "unknown";
  const age = finalAge !== null ? `${Math.round(finalAge / 1000)}s` : "unknown";
  const nonce = finalPayload?.nonce ?? "unknown";
  throw new DmossError({
    code: ErrorCode.SESSION_PERSIST_FAILED,
    message: `获取会话写锁超时: ${sessionFile} (PID ${pid}, age ${age}, nonce ${nonce})`,
  });
}
