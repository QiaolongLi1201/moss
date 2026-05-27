/**
 * Provider 错误分类与重试
 *
 * 设计:
 * - 错误分类: 将 LLM API 错误归入有限类别，决定重试策略
 * - 指数退避: 避免在限速/过载时疯狂重试
 * - Context Overflow: 单独处理，触发自动 compact 而非简单重试
 */

// ============== 错误分类 ==============

/**
 * Failover 原因
 *
 * FailoverReason — classifies transient LLM errors
 */
export type FailoverReason =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "connection"
  | "billing"
  | "format"
  | "unknown";

/**
 * FailoverError — 带分类信息的错误
 *
 * FailoverError — wraps transient provider errors with retry metadata
 * - 携带错误原因、provider、model 等元数据
 * - 上层可根据 reason 决定重试/切换/放弃
 */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// ============== 错误模式匹配 ==============

/**
 * Error pattern matchers for various LLM provider error messages
 */

const RATE_LIMIT_PATTERNS = [
  "rate_limit",
  "too many requests",
  "429",
  "exceeded quota",
  "resource exhausted",
  "quota exceeded",
  "resource_exhausted",
  "usage limit",
];

const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "deadline exceeded",
  "context deadline exceeded",
  "etimedout",
  "first chunk",
  "first event",
  "no streaming output",
];

const CONNECTION_PATTERNS = [
  "econnreset",
  "econnrefused",
  "socket hang up",
  "network error",
  "fetch failed",
  "enotfound",
  "epipe",
  "ehostunreach",
  "enetunreach",
  "unreachable",
];

const AUTH_PATTERNS = [
  "invalid_api_key",
  "incorrect api key",
  "invalid token",
  "authentication",
  "unauthorized",
  "forbidden",
  "access denied",
  "expired",
  "401",
  "403",
];

const BILLING_PATTERNS = [
  "402",
  "payment required",
  "insufficient credits",
  "credit balance",
];

const FORMAT_PATTERNS = [
  "string should match pattern",
  "invalid request format",
];

const CONTEXT_OVERFLOW_PATTERNS = [
  "request_too_large",
  "context_length_exceeded",
  "request exceeds the maximum size",
  "context length exceeded",
  "maximum context length",
  "prompt is too long",
  "exceeds model context window",
  "context overflow",
  /** 豆包 / 部分 OpenAI 兼容网关：长度上限（字符或 token 计量） */
  "exceeds the maximum length",
  "maximum input length",
  "token limit exceeded",
  "context window is full",
  /** 通义/智谱/讯飞/Moonshot 等中文网关常见文案 */
  "上下文过长",
  "上下文超长",
  "上下文超限",
  "上下文超出",
  "上下文长度",
  "输入过长",
  "输入超长",
  "请求过长",
  "请求超长",
  "超过最大",
  "超出最大",
  "tokens 超限",
  "tokens超限",
  "tokens 过多",
  /** 一些代理在响应体里会带英文短语但 status 走非 400/413 */
  "too many tokens",
  "input is too long",
  "input length",
  "prompt length",
];

function matchesAny(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Context Overflow 检测
 *
 * Detect context window overflow errors across providers
 * - 与普通 failover 分开处理
 * - 触发 auto-compact 而非简单重试
 */
export function isContextOverflowError(message?: string): boolean {
  if (!message) return false;
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return true;
  const lower = message.toLowerCase();
  // 413 + "too large" 组合
  if (lower.includes("413") && lower.includes("too large")) return true;
  // 400 + 明确长度越界（避免把泛化的 400 都当成 overflow）
  if (
    /\b400\b/.test(lower) &&
    (lower.includes("maximum length") || lower.includes("input length") || lower.includes("context length"))
  ) {
    return true;
  }
  if (/input length \d+ exceeds (?:the )?maximum \d+/.test(lower)) return true;
  if (/exceeds (?:the )?maximum (?:input )?length/.test(lower)) return true;
  return false;
}

export function isRateLimitError(message?: string): boolean {
  return !!message && matchesAny(message, RATE_LIMIT_PATTERNS);
}

/**
 * Quota/billing exhaustion — NOT retryable (unlike transient rate limits).
 * Matches 402 Payment Required, credit balance, and quota-plan errors.
 */
const QUOTA_EXHAUSTED_PATTERNS = [
  "402",
  "payment required",
  "insufficient credits",
  "credit balance",
  "insufficient_quota",
  "out of credits",
  "plan quota",
  "plan limit",
];

export function isQuotaExceededError(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (matchesAny(lower, QUOTA_EXHAUSTED_PATTERNS)) return true;
  return /exceeded (?:the |your )?(?:monthly |daily |current )?(?:usage )?quota|monthly usage (?:quota|limit)|usage limit (?:exceeded|reached)/.test(lower);
}

export function isTimeoutError(message?: string): boolean {
  return !!message && matchesAny(message, TIMEOUT_PATTERNS);
}

/** 网络连接错误（连接拒绝、重置、DNS 失败等） */
export function isConnectionError(message?: string): boolean {
  return !!message && matchesAny(message, CONNECTION_PATTERNS);
}

/** 5xx 服务端错误（overloaded、internal server error 等） */
export function isServerError(message?: string): boolean {
  if (!message) return false;
  return /\b(5\d{2})\b/.test(message) ||
    /overloaded|internal.server.error|bad gateway|service unavailable|gateway timeout/i.test(message);
}

/**
 * 判断错误是否为瞬时错误（值得重试）
 * 常见可重试类别：rate_limit + timeout + 网络错误 + 5xx（业界惯例）
 */
export function isTransientError(message?: string): boolean {
  if (!message) return false;
  return isRateLimitError(message) || isTimeoutError(message) || isConnectionError(message) || isServerError(message);
}

export function isAuthError(message?: string): boolean {
  return !!message && matchesAny(message, AUTH_PATTERNS);
}

/**
 * 分类错误原因
 *
 * Classify an error into a FailoverReason category
 * - 按优先级匹配: billing > auth > rate_limit > timeout > format > null
 */
export function classifyFailoverReason(message: string): FailoverReason | null {
  if (matchesAny(message, BILLING_PATTERNS)) return "billing";
  if (matchesAny(message, AUTH_PATTERNS)) return "auth";
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchesAny(message, TIMEOUT_PATTERNS)) return "timeout";
  if (matchesAny(message, CONNECTION_PATTERNS)) return "connection";
  if (matchesAny(message, FORMAT_PATTERNS)) return "format";
  return null;
}

/**
 * 判断错误是否值得触发 failover（切换 profile / model）
 *
 * Check if an error message indicates a failover error
 */
export function isFailoverErrorMessage(message?: string): boolean {
  if (!message) return false;
  const reason = classifyFailoverReason(message);
  // timeout 和 connection 不触发 failover（网络抖动，不是 provider 能力问题）
  return reason !== null && reason !== "timeout" && reason !== "connection";
}

// ============== 指数退避重试 ==============

/**
 * 重试配置
 *
 * RetryOptions for exponential backoff
 */
export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  attempts?: number;
  /** 最小延迟（默认 300ms） */
  minDelayMs?: number;
  /** 最大延迟（默认 30000ms） */
  maxDelayMs?: number;
  /** 抖动系数 0-1（默认 0.25，业界惯例） */
  jitter?: number;
  /** 日志标签 */
  label?: string;
  /** 是否应该重试（返回 false 则直接抛出） */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 覆盖本次重试延迟；返回 undefined 则使用指数退避 + Retry-After 规则 */
  retryDelayMs?: (err: unknown, attempt: number, computedDelayMs: number) => number | undefined;
  /** 重试回调 */
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

/**
 * 带指数退避的异步重试
 *
 * Retry an async function with exponential backoff
 *
 * 退避公式: delay = minDelayMs * 2^(attempt-1)
 * 加抖动:   delay *= (1 + random(-jitter, +jitter))
 * 上下界:   clamp(minDelayMs, maxDelayMs)
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const minDelayMs = options?.minDelayMs ?? 300;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const jitter = options?.jitter ?? 0.25; // 25% 随机抖动（业界惯例）

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;
      if (options?.shouldRetry && !options.shouldRetry(err, attempt)) break;

      // 指数退避
      let delay = minDelayMs * 2 ** (attempt - 1);

      // 尊重 HTTP Retry-After 响应头（RFC 7231 §7.1.3）
      const errMsg = describeError(err);
      const retryAfterMatch = errMsg.match(/retry.after[:\s]*(\d+)/i);
      if (retryAfterMatch) {
        const retryAfterMs = parseInt(retryAfterMatch[1], 10) * 1000;
        if (retryAfterMs > 0 && retryAfterMs < maxDelayMs * 2) {
          delay = retryAfterMs;
        }
      }

      // 抖动
      if (jitter > 0) {
        const offset = (Math.random() * 2 - 1) * jitter;
        delay *= 1 + offset;
      }

      // 上下界
      delay = Math.max(Math.min(delay, maxDelayMs), minDelayMs);
      const overrideDelay = options?.retryDelayMs?.(err, attempt, delay);
      if (overrideDelay !== undefined && Number.isFinite(overrideDelay)) {
        delay = Math.max(0, overrideDelay);
      }

      options?.onRetry?.({ attempt, delay, error: err });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============== 描述错误 ==============

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
