/**
 * Command queue — session-level and global-level concurrency control.
 *
 * Two-tier lane design:
 * - Session Lane (outer, maxConcurrent=1): ensures serial requests per session
 * - Global Lane (inner, configurable): controls cross-session concurrency
 */

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  warnAfterMs: number;
};

type LaneState = {
  lane: string;
  active: number;
  queue: Array<QueueEntry<unknown>>;
  maxConcurrent: number;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) return existing;
  const created: LaneState = { lane, active: 0, queue: [], maxConcurrent: 1 };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.active === 0 && state.queue.length === 0) {
    lanes.delete(lane);
    return;
  }
  while (state.active < state.maxConcurrent && state.queue.length > 0) {
    const entry = state.queue.shift() as QueueEntry<unknown>;
    state.active += 1;
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > entry.warnAfterMs && entry.onWait) {
      entry.onWait(waitMs, state.queue.length);
    }
    void (async () => {
      try {
        const result = await entry.task();
        state.active -= 1;
        drainLane(lane);
        entry.resolve(result);
      } catch (err) {
        state.active -= 1;
        drainLane(lane);
        entry.reject(err);
      }
    })();
  }
}

export function setLaneConcurrency(lane: string, maxConcurrent: number) {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(lane);
}

export interface EnqueueOpts {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

export function enqueueInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: EnqueueOpts,
): Promise<T> {
  const state = getLaneState(lane);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });
    drainLane(lane);
  });
}

export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || 'main';
  return cleaned.startsWith('session:') ? cleaned : `session:${cleaned}`;
}

export function deleteLane(lane: string): boolean {
  const state = lanes.get(lane);
  if (!state) return false;
  if (state.active > 0 || state.queue.length > 0) return false;
  return lanes.delete(lane);
}

export function resolveGlobalLane(lane?: string): string {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : 'main';
}
