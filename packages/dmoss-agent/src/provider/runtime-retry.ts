/**
 * Provider 透明自动重试 helper —— `2026-05-01-moss-reliability-fallback-ux` G-2 引入。
 *
 * 用途：在 caller（例如 `pi-ai-adapter.ts` 的 stream 错误分支 / Studio 侧
 *  `ErrorClassifyBroker`）拿到一个 `ProviderErrorSurface` 后，根据
 *  `surface.retryable` 字段决定是否做**最多 1 次**透明重试，避免用户看到
 *  瞬时 `aborted_by_server` / `rate_limit` / `network` / `timeout` 报错。
 *
 * 严格约束（**禁止**调高这些约束，否则违背 spec.md G-2）：
 *  - **最多 1 次重试**（`maxAttempts` 硬上限 1，类型签名只允许 1）
 *  - **仅 `surface.retryable === true` 才重试**——`auth` / `quota_exceeded` /
 *    `context_corruption` 重试无效，直接抛出
 *  - **重试时 fn 必须使用与首次 byte-equal 的 messages 数组**——本 helper 不修改
 *    任何输入参数，只是再调一次同一个 `fn`；caller 的责任是保证 `fn` 是 idempotent
 *  - **abort signal 触发时立即停止，不再重试**（用户取消整轮的语义优先）
 *  - **不静默吞错**——若两次都失败，最终抛出"最后一次"的错误（不是首次）
 *
 * 与 SSE meta 的关系：caller 通过 `onRetry` 回调可在重试发起前向 SSE
 * `meta.retry { attempt: 1, willRetry: true }` 投递事件；本 helper 不直接接触
 * SSE 协议（保持包级中立），由 server 侧 broker 把 callback 接到 `pushSseEvent`。
 *
 * 性能：仅在错误路径生效；正常路径零开销（直接 await fn）。
 *
 * 例：
 *   const result = await runWithProviderRetry(
 *     () => provider.streamChat(payload),
 *     {
 *       classify: (err) => classifyProviderError({ errorMessage: String(err) }),
 *       onRetry: ({ attempt, category, backoffMs }) => {
 *         pushEvent({ type: 'meta', data: { retry: { attempt, category, backoffMs, willRetry: true } } });
 *       },
 *       signal: abortController.signal,
 *     },
 *   );
 */

import type { ProviderErrorCategory, ProviderErrorSurface } from './error-classify.js';

export interface RuntimeRetryInfo {
  /** 当前重试编号；首次失败后的重试 = 1（永远 ≤ maxAttempts） */
  attempt: number;
  /** 这次错误对应的分类 */
  category: ProviderErrorCategory;
  /** 实际等待的 backoff 毫秒数 */
  backoffMs: number;
  /** 当前是否会触发重试。`false` 表示这是"重试已用尽 / 不可重试 / aborted"的终态信号，
   *  caller 可借此清理 placeholder UI */
  willRetry: boolean;
}

export interface RuntimeRetryOptions {
  /**
   * 把 thrown error 翻译成 `ProviderErrorSurface` 的回调。
   * caller 必须提供（pure：不要在这里再做副作用）。
   */
  classify: (err: unknown) => ProviderErrorSurface;
  /**
   * 重试发起前的回调；`willRetry === true` 表示马上要 sleep + 重试，
   * `willRetry === false` 表示这是终态错误（不会重试，用于 UI 收尾）。
   */
  onRetry?: (info: RuntimeRetryInfo) => void;
  /**
   * Backoff 区间 `[minMs, maxMs]`；实际等待时长 = 区间内 jittered 均匀分布。
   * 默认 [800, 2000]（per design.md）；上下界由 caller 自行决定，但建议保持默认。
   */
  backoffMs?: [number, number];
  /**
   * 进一步限制是否重试的 hook（在 `surface.retryable === true` 之后调用）；
   * 返回 false 时即使 retryable 也跳过重试。可用于例如"用户在 settings 关了 auto-retry"。
   * 默认全部允许。
   */
  shouldRetry?: (surface: ProviderErrorSurface) => boolean;
  /**
   * 用户取消信号；触发时立即抛 last error，不再重试。
   */
  signal?: AbortSignal;
  /**
   * 最大重试次数。**类型上限 1**；spec.md G-2 硬约束。
   * 若 caller 想"不重试"应该用 `shouldRetry: () => false` 而不是把这个设为 0。
   */
  maxAttempts?: 1;
}

const DEFAULT_BACKOFF: [number, number] = [800, 2000];

function jitteredBackoff(range: [number, number]): number {
  const [min, max] = range;
  if (max <= min) return min;
  // 均匀分布；不需要密码学随机
  const jitter = Math.random() * (max - min);
  return Math.floor(min + jitter);
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 包装一个 async fn 让它在 transient 错误（`surface.retryable === true`）下做
 * 最多一次透明重试。
 *
 * @deprecated since 0.4.0, removal target 1.0. Use retryAsync instead. See MIGRATION.md.
 */
export async function runWithProviderRetry<T>(
  fn: () => Promise<T>,
  opts: RuntimeRetryOptions,
): Promise<T> {
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? new Error('aborted');
  }

  let lastError: unknown;
  try {
    return await fn();
  } catch (err) {
    lastError = err;
  }

  // First attempt failed — decide whether to retry
  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  const surface = opts.classify(lastError);

  const allowed =
    surface.retryable && (opts.shouldRetry ? opts.shouldRetry(surface) : true);

  const backoffMs = jitteredBackoff(opts.backoffMs ?? DEFAULT_BACKOFF);

  if (!allowed) {
    // Not retryable — emit terminal info if caller cares
    opts.onRetry?.({
      attempt: 1,
      category: surface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw lastError;
  }

  // Notify caller that retry is about to happen
  opts.onRetry?.({
    attempt: 1,
    category: surface.category,
    backoffMs,
    willRetry: true,
  });

  try {
    await delayWithSignal(backoffMs, opts.signal);
  } catch (waitErr) {
    // Aborted during wait — surface the original error (not the abort)
    throw lastError;
  }

  if (opts.signal?.aborted) {
    throw opts.signal.reason ?? lastError;
  }

  // Single retry; if this fails, throw final error (no further attempts)
  try {
    return await fn();
  } catch (retryErr) {
    // Notify caller that retry has finished and failed
    const retrySurface = opts.classify(retryErr);
    opts.onRetry?.({
      attempt: 1,
      category: retrySurface.category,
      backoffMs: 0,
      willRetry: false,
    });
    throw retryErr;
  }
}
