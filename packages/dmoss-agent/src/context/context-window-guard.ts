/**
 * Context window guard — validates and enforces context window token limits.
 *
 * Provides configurable thresholds for warning (too small but usable)
 * and blocking (below hard minimum) context window sizes.
 */

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource = 'agentContextTokens' | 'default';

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function resolveContextWindowInfo(params: {
  contextTokens?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromAgent = normalizePositiveInt(params.contextTokens);
  if (fromAgent) {
    return { tokens: fromAgent, source: 'agentContextTokens' };
  }
  return { tokens: Math.floor(params.defaultTokens), source: 'default' };
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
};

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS));
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
