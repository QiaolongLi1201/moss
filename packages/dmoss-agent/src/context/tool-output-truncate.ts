/**
 * 工具输出智能截断（aligned with Codex best practices）
 *
 * Strategy: head + tail truncation with equal 50/50 split.
 * Limits are expressed in approximate token units (bytes / 4) rather than
 * raw characters, following Codex's recommendation for better model utilization.
 *
 * Why 50/50 instead of 60/40:
 * - Codex found that tail content (final output, error summaries, return values)
 *   is equally important as head content (command start, initial errors)
 * - Equal split avoids systematic bias toward either end
 * - Middle truncation marker uses "…N tokens truncated…" format for clarity
 */

/**
 * Default tool output truncation limits (in approximate tokens, ~4 bytes each).
 * Host apps can register additional limits via `registerToolOutputLimits()`.
 */
const BASE_TOOL_OUTPUT_LIMITS: Record<string, number> = {
  device_exec: 6_000,
  device_file_read: 10_000,
  read: 10_000,
  web_search: 2_250,
  web_fetch: 8_000,
  device_diagnose: 3_000,
  exec: 4_500,
  bash: 4_500,
};

let _extraToolOutputLimits: Record<string, number> = {};

/**
 * Register additional tool output limits (in tokens) for host-specific tools.
 * Merges with (and can override) the base limits.
 */
export function registerToolOutputLimits(limits: Record<string, number>): void {
  _extraToolOutputLimits = { ..._extraToolOutputLimits, ...limits };
}

function getToolOutputLimitTokens(toolName: string): number {
  return _extraToolOutputLimits[toolName] ?? BASE_TOOL_OUTPUT_LIMITS[toolName] ?? DEFAULT_LIMIT_TOKENS;
}

const DEFAULT_LIMIT_TOKENS = 4_000;
const BYTES_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/**
 * Smart tool output truncation: head + tail with 50/50 split.
 * Uses token approximation (bytes/4) for budget calculation.
 */
export function truncateToolOutput(toolName: string, output: string): string {
  const limitTokens = getToolOutputLimitTokens(toolName);
  const outputTokens = estimateTokens(output);

  if (outputTokens <= limitTokens) return output;

  const limitBytes = limitTokens * BYTES_PER_TOKEN;
  const halfBytes = Math.floor(limitBytes / 2);

  const headEnd = findSafeSlicePoint(output, halfBytes, 'forward');
  const tailStart = findSafeSlicePoint(output, halfBytes, 'backward');

  if (headEnd >= tailStart) return output;

  const head = output.slice(0, headEnd);
  const tail = output.slice(tailStart);
  const droppedTokens = estimateTokens(output.slice(headEnd, tailStart));

  return `${head}\n\n…${droppedTokens} tokens truncated…\n\n${tail}`;
}

/**
 * Find a safe UTF-8 boundary to slice at, snapping to the nearest newline
 * within a small window to avoid breaking lines mid-content.
 */
function findSafeSlicePoint(text: string, targetBytes: number, direction: 'forward' | 'backward'): number {
  const approxCharIndex = Math.min(text.length, Math.floor(targetBytes));

  if (direction === 'forward') {
    const searchStart = Math.max(0, approxCharIndex - 100);
    const searchEnd = Math.min(text.length, approxCharIndex + 100);
    const newlineIdx = text.lastIndexOf('\n', searchEnd);
    if (newlineIdx >= searchStart) return newlineIdx + 1;
    return approxCharIndex;
  }

  const searchStart = Math.max(0, text.length - approxCharIndex - 100);
  const searchEnd = Math.min(text.length, text.length - approxCharIndex + 100);
  const newlineIdx = text.indexOf('\n', searchStart);
  if (newlineIdx >= 0 && newlineIdx <= searchEnd) return newlineIdx;
  return text.length - approxCharIndex;
}
