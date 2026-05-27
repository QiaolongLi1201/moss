/**
 * 上下文「窗口经济学」— 自动压缩 / 预算计算的常量来源（Inspired by Claude Code's
 * public auto-compact thresholds; concrete values re-derived for our workloads）
 *
 * - 有效窗口 = 模型上下文窗 − min(max_output, 摘要输出上限)，避免把「留给模型输出」的额度算进可用历史
 * - 自动压缩触发线 = 有效窗口 − buffer（默认 13k），在「满之前」主动压历史
 *
 * 产品侧可参考（思路一致，非实现绑定）：
 * - VS Code Copilot：用量指示 + 将满时自动 compact + 用户 `/compact` 与「Compact Conversation」
 * - Kiro CLI：溢出时自动 compact、`/context show` 可观测、大上下文用 Knowledge Base 按需检索而非整段塞窗
 */

import { parseEnvBoundedFloat, parseEnvBoundedInt } from '../utils/env-compat.js';

/** 摘要/compact 调用预留输出上限（order-of-magnitude reserve for summary output） */
export const SUMMARY_OUTPUT_CAP_TOKENS = 20_000;

/**
 * autocompact 缓冲带：剩余窗口低于此值即触发压缩。
 * - 13_000 是 200k 模型经验值；小窗口模型（32k/8k 网关）需要更大的相对缓冲，
 *   否则真实输出还没开始就先超限。
 * - 通过 `DMOSS_AUTOCOMPACT_BUFFER_TOKENS` 覆盖（仅取 1_000 ~ 80_000）。
 */
function resolveAutoCompactBuffer(): number {
  return parseEnvBoundedInt('DMOSS_AUTOCOMPACT_BUFFER_TOKENS', 13_000, 1_000, 80_000);
}

export const AUTOCOMPACT_BUFFER_TOKENS = resolveAutoCompactBuffer();

/** 预警带：距触发线再往前 20k（对齐 WARNING_THRESHOLD_BUFFER 思路，用于 UI/日志） */
export const WARNING_BAND_TOKENS = 20_000;

const MIN_EFFECTIVE_WINDOW = 4_000;

/**
 * 「窗口经济学」相对缓冲：默认按窗口大小动态决定 autocompact 触发线，避免在
 * 32k 网关上还套用 200k 的 13k 缓冲（实际剩余太小 → 模型一开口就超限）。
 *
 * 规则：
 * - 缓冲 = max( 静态 AUTOCOMPACT_BUFFER_TOKENS,  窗口 * RATIO ,  MIN )
 * - RATIO 默认 0.18（即在 32k 窗口上预留 ~5.8k；在 128k 窗口上预留 ~23k）
 * - 可通过 `DMOSS_AUTOCOMPACT_BUFFER_RATIO` 覆盖（仅取 0.05~0.5）
 */
function resolveAutoCompactBufferRatio(): number {
  return parseEnvBoundedFloat('DMOSS_AUTOCOMPACT_BUFFER_RATIO', 0.18, 0.05, 0.5);
}

const AUTOCOMPACT_BUFFER_RATIO = resolveAutoCompactBufferRatio();
const MIN_DYNAMIC_BUFFER = 2_000;

function resolveDynamicBuffer(effectiveContextWindowTokens: number): number {
  return Math.max(
    AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(effectiveContextWindowTokens * AUTOCOMPACT_BUFFER_RATIO),
    MIN_DYNAMIC_BUFFER,
  );
}

/**
 * 有效上下文 token 上限（历史+系统估算应控制在此以内，再留输出位）
 */
export function getEffectiveContextWindowTokens(
  contextWindowTokens: number,
  maxOutputTokens: number,
): number {
  const reserved = Math.min(Math.max(0, maxOutputTokens), SUMMARY_OUTPUT_CAP_TOKENS);
  return Math.max(MIN_EFFECTIVE_WINDOW, contextWindowTokens - reserved);
}

/**
 * 达到此估算 token 即应触发「主动压缩」判断（在 API 报 context overflow 之前）。
 * 动态缓冲：小窗口模型用相对比例（默认 18%），大窗口仍维持 13k 起步。
 */
export function getProactiveCompactThreshold(effectiveContextWindowTokens: number): number {
  return Math.max(
    MIN_EFFECTIVE_WINDOW,
    effectiveContextWindowTokens - resolveDynamicBuffer(effectiveContextWindowTokens),
  );
}

/**
 * 预警阈值（仍低于 proactive 触发线）：用于遥测/后续 UI
 */
export function getContextWarningThreshold(effectiveContextWindowTokens: number): number {
  return Math.max(
    0,
    getProactiveCompactThreshold(effectiveContextWindowTokens) - WARNING_BAND_TOKENS,
  );
}

export function shouldProactiveCompactByWindowEconomics(params: {
  estimatedPromptTokens: number;
  effectiveContextWindowTokens: number;
}): boolean {
  return params.estimatedPromptTokens >= getProactiveCompactThreshold(params.effectiveContextWindowTokens);
}
