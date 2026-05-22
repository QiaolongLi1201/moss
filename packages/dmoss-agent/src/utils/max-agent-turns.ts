/**
 * Agent turn limits — configurable max reasoning turns per user message.
 */

export const DMOSS_DEFAULT_MAX_AGENT_TURNS = 64;

/** Hard cap for DMOSS_MAX_AGENT_TURNS env var */
export const DMOSS_MAX_AGENT_TURNS_HARD_CAP = 256;

export function resolveDmossMaxAgentTurns(envValue?: string | undefined): number {
  const raw = envValue ?? process.env.DMOSS_MAX_AGENT_TURNS?.trim();
  if (raw) {
    const n = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n > 0) return Math.min(DMOSS_MAX_AGENT_TURNS_HARD_CAP, n);
  }
  return DMOSS_DEFAULT_MAX_AGENT_TURNS;
}

/**
 * After maxTurns is reached, allow extra LLM calls if there are pending tool_results.
 * Scales with maxTurns and caps at 192 to prevent runaway loops.
 */
export function resolveToolFollowupBypassCap(maxTurns: number): number {
  const scaled = maxTurns + Math.floor(maxTurns / 2) + 32;
  return Math.min(192, scaled);
}
