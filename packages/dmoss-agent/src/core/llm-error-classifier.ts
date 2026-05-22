import { describeError, isContextOverflowError } from '../provider/errors.js';

export type LlmErrorCategory =
  | 'context_overflow'
  | 'timeout'
  | 'server_error'
  | 'connection'
  | 'rate_limit'
  | 'max_tokens'
  | 'client_error'
  | 'premature_close'
  | 'user_abort'
  | 'unknown';

export interface LlmErrorClassification {
  category: LlmErrorCategory;
  retryable: boolean;
  message: string;
}

function hasStatus(message: string, pattern: RegExp): boolean {
  return pattern.test(message);
}

function isAbortLike(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower === 'aborted' || lower.includes('aborterror') || lower.includes('request was aborted')
  );
}

function isPrematureClose(message: string): boolean {
  return /err_stream_premature_close|premature close|stream closed prematurely|other side closed|stream.*terminated|^(?:llm\s+stream\s+error:\s*)?terminated\.?$/i.test(
    message,
  );
}

function isRateLimit(message: string): boolean {
  return /\b429\b|rate[ _-]?limit|too many requests|resource exhausted|resource_exhausted/i.test(
    message,
  );
}

function isConnection(message: string): boolean {
  return /econnreset|econnrefused|enotfound|eai_again|epipe|socket hang up|network ?error|fetch failed|networkerror/i.test(
    message,
  );
}

function isTimeout(message: string): boolean {
  return /timed? ?out|timeout|deadline exceeded|first[ -]?chunk|first[ -]?event|no streaming output/i.test(
    message,
  );
}

function isServer(message: string): boolean {
  return (
    hasStatus(message, /\b5\d{2}\b/) ||
    /overloaded|internal server error|bad gateway|service unavailable|gateway timeout|upstream.*error|server is busy/i.test(
      message,
    )
  );
}

function isMaxTokens(message: string): boolean {
  const lower = message.toLowerCase();
  if (!lower.includes('max')) return false;
  return /max[_ -]?(?:output[_ -]?)?tokens?.{0,80}(?:too large|exceeds?|must be|greater than|less than or equal|<=|maximum)|(?:too large|exceeds?|greater than).{0,80}max[_ -]?(?:output[_ -]?)?tokens?/i.test(
    message,
  );
}

function isClient(message: string): boolean {
  if (isContextOverflowError(message)) return false;
  if (isRateLimit(message)) return false;
  return (
    hasStatus(message, /\b4\d{2}\b/) ||
    /invalid request|bad request|unsupported|not supported|malformed|schema|tool.*not found|tool result.*not found/i.test(
      message,
    )
  );
}

export function classifyLlmError(error: unknown): LlmErrorClassification {
  const message = describeError(error);

  if (isAbortLike(message)) {
    return { category: 'user_abort', retryable: false, message };
  }
  if (isContextOverflowError(message)) {
    return { category: 'context_overflow', retryable: false, message };
  }
  if (isMaxTokens(message)) {
    return { category: 'max_tokens', retryable: false, message };
  }
  if (isPrematureClose(message)) {
    return { category: 'premature_close', retryable: true, message };
  }
  if (isRateLimit(message)) {
    return { category: 'rate_limit', retryable: true, message };
  }
  if (isTimeout(message)) {
    return { category: 'timeout', retryable: true, message };
  }
  if (isConnection(message)) {
    return { category: 'connection', retryable: true, message };
  }
  if (isServer(message)) {
    return { category: 'server_error', retryable: true, message };
  }
  if (isClient(message)) {
    return { category: 'client_error', retryable: false, message };
  }

  return { category: 'unknown', retryable: false, message };
}

/**
 * Exponential backoff for rate limits (aligned with Codex strategy):
 * base_delay * 2^(attempt-1), capped at 60s. Also parses server-suggested
 * retry-after hints from the error message (e.g. "try again in 1.3s").
 *
 * For server errors and connection issues, uses a shorter base delay
 * with the same exponential growth.
 */
const RATE_LIMIT_BASE_DELAY_MS = 2_500;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const TRANSIENT_BASE_DELAY_MS = 1_000;
const TRANSIENT_MAX_DELAY_MS = 30_000;

function parseServerSuggestedRetryMs(message: string): number | null {
  const m = /(?:retry|try)\s+again\s+in\s+([\d.]+)\s*s/i.exec(message);
  if (m?.[1]) {
    const suggested = parseFloat(m[1]) * 1000;
    if (!Number.isNaN(suggested) && suggested > 0) return suggested;
  }
  const retryAfterHeader = /retry[- ]after:\s*([\d.]+)/i.exec(message);
  if (retryAfterHeader?.[1]) {
    const secs = parseFloat(retryAfterHeader[1]) * 1000;
    if (!Number.isNaN(secs) && secs > 0) return secs;
  }
  return null;
}

export function retryDelayForLlmError(
  classification: LlmErrorClassification,
  attempt: number = 1,
): number | undefined {
  if (classification.category === 'rate_limit') {
    const serverHint = parseServerSuggestedRetryMs(classification.message);
    if (serverHint !== null) return Math.min(serverHint, RATE_LIMIT_MAX_DELAY_MS);
    return Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_DELAY_MS);
  }
  if (
    classification.category === 'server_error' ||
    classification.category === 'connection' ||
    classification.category === 'premature_close'
  ) {
    return Math.min(TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1), TRANSIENT_MAX_DELAY_MS);
  }
  return undefined;
}
