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

export interface EnqueueOpts {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

export class CommandQueueRegistry {
  private lanes = new Map<string, LaneState>();

  private getLaneState(lane: string): LaneState {
    const existing = this.lanes.get(lane);
    if (existing) return existing;
    const created: LaneState = { lane, active: 0, queue: [], maxConcurrent: 1 };
    this.lanes.set(lane, created);
    return created;
  }

  private drainLane(lane: string) {
    const state = this.getLaneState(lane);
    if (state.active === 0 && state.queue.length === 0) {
      this.lanes.delete(lane);
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
          this.drainLane(lane);
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          this.drainLane(lane);
          entry.reject(err);
        }
      })();
    }
  }

  setConcurrency(lane: string, maxConcurrent: number): void {
    const state = this.getLaneState(lane);
    state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.drainLane(lane);
  }

  enqueue<T>(
    lane: string,
    task: () => Promise<T>,
    opts?: EnqueueOpts,
  ): Promise<T> {
    const state = this.getLaneState(lane);
    return new Promise<T>((resolve, reject) => {
      state.queue.push({
        task: () => task(),
        resolve: (value) => resolve(value as T),
        reject,
        enqueuedAt: Date.now(),
        warnAfterMs: opts?.warnAfterMs ?? 2_000,
        onWait: opts?.onWait,
      });
      this.drainLane(lane);
    });
  }

  resolveSessionLane(sessionKey: string): string {
    const cleaned = sessionKey.trim() || 'main';
    return cleaned.startsWith('session:') ? cleaned : `session:${cleaned}`;
  }

  resolveGlobalLane(lane?: string): string {
    const cleaned = lane?.trim();
    return cleaned ? cleaned : 'main';
  }

  delete(lane: string): boolean {
    const state = this.lanes.get(lane);
    if (!state) return false;
    if (state.active > 0 || state.queue.length > 0) return false;
    return this.lanes.delete(lane);
  }
}

const defaultRegistry = new CommandQueueRegistry();

/**
 * @deprecated since 0.4.0, removal target 0.5.0. Use `CommandQueueRegistry.setConcurrency()` instead.
 * ```ts
 * // before
 * setLaneConcurrency(lane, 4);
 * // after
 * agent.commandQueues.setConcurrency(lane, 4);
 * ```
 */
export function setLaneConcurrency(lane: string, maxConcurrent: number) {
  defaultRegistry.setConcurrency(lane, maxConcurrent);
}

/**
 * @deprecated since 0.4.0, removal target 0.5.0. Use `CommandQueueRegistry.enqueue()` instead.
 * ```ts
 * // before
 * enqueueInLane(lane, fn);
 * // after
 * agent.commandQueues.enqueue(lane, fn);
 * ```
 */
export function enqueueInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: EnqueueOpts,
): Promise<T> {
  return defaultRegistry.enqueue(lane, task, opts);
}

/**
 * @deprecated since 0.4.0, removal target 0.5.0. Use `CommandQueueRegistry.resolveSessionLane()` instead.
 */
export function resolveSessionLane(sessionKey: string): string {
  return defaultRegistry.resolveSessionLane(sessionKey);
}

/**
 * @deprecated since 0.4.0, removal target 0.5.0. Use `CommandQueueRegistry.delete()` instead.
 */
export function deleteLane(lane: string): boolean {
  return defaultRegistry.delete(lane);
}

/**
 * @deprecated since 0.4.0, removal target 0.5.0. Use `CommandQueueRegistry.resolveGlobalLane()` instead.
 */
export function resolveGlobalLane(lane?: string): string {
  return defaultRegistry.resolveGlobalLane(lane);
}
