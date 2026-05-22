/**
 * MicroCompact — 轻量级 tool_result 压缩
 *
 * Inspired by the public behaviour of Claude Code's auto-compaction: replace
 * fully-consumed tool_result bodies with a placeholder so the model only pays
 * tokens for the results it still needs to read. Independently implemented.
 *
 * 核心思想：
 * - 每轮 LLM 调用前，自动把"旧的" tool_result 内容替换为占位符
 * - 零 LLM 调用，纯字符串操作，几乎无延迟
 * - 大幅减少 token 消耗（tool_result 通常占上下文的 60-80%）
 *
 * "旧的"定义：
 * - 不在最近 N 条 assistant 消息的 tool_use 关联范围内
 * - 即：LLM 已经"看过"这些结果并做出了回应，不需要再看原文
 *
 * 保护规则：
 * - 最近 keepRecentResults 个 tool_result 不压缩（默认 6）
 * - 内容短于 minContentLength 的不压缩（默认 200 字符）
 * - 已经是占位符的不重复压缩
 */

import type { Message, ContentBlock } from '../core/session-jsonl.js';
import { estimateTokensForText } from './tokens.js';

export interface MicroCompactConfig {
  /** 保留最近 N 个 tool_result 不压缩 */
  keepRecentResults: number;
  /** 内容短于此长度的不压缩（字符数） */
  minContentLength: number;
  /** 压缩后的占位符模板 */
  placeholder: string;
}

export const DEFAULT_MICRO_COMPACT_CONFIG: MicroCompactConfig = {
  keepRecentResults: 6,
  minContentLength: 200,
  placeholder: '[内容已压缩 — 此工具结果已被 Agent 处理，原文已省略以节省上下文空间]',
};

export interface MicroCompactResult {
  messages: Message[];
  compressedCount: number;
  /** 相对占位符多回收的字符数（物理量，便于排障与日志） */
  savedChars: number;
  /** 相对占位符多回收的 token 估算（CJK 感知；用户可见文案的主单位） */
  savedTokens: number;
}

/**
 * 对消息列表执行 microcompact。
 *
 * 返回新的消息数组（不修改原数组），其中旧的 tool_result 内容被替换为占位符。
 */
export function microcompact(
  messages: Message[],
  config: Partial<MicroCompactConfig> = {},
): MicroCompactResult {
  const cfg = { ...DEFAULT_MICRO_COMPACT_CONFIG, ...config };

  // 1. 收集所有 tool_result 的位置（消息索引 + 块索引）
  const allToolResults: Array<{
    msgIdx: number;
    blockIdx: number;
    content: string;
  }> = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (typeof msg.content === 'string') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length >= cfg.minContentLength &&
        block.content !== cfg.placeholder
      ) {
        allToolResults.push({ msgIdx: mi, blockIdx: bi, content: block.content });
      }
    }
  }

  if (allToolResults.length === 0) {
    return { messages, compressedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  // 2. 保护最近 N 个 tool_result
  const compressible = allToolResults.slice(
    0,
    Math.max(0, allToolResults.length - cfg.keepRecentResults),
  );

  if (compressible.length === 0) {
    return { messages, compressedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  // 3. 构建压缩后的消息数组（深拷贝被修改的消息）
  const compressSet = new Set(compressible.map((c) => `${c.msgIdx}:${c.blockIdx}`));
  /** 占位符的 token 成本只算一次：每次被替换都是同一段 placeholder，开销极低也只需减一次 */
  const placeholderTokens = estimateTokensForText(cfg.placeholder);
  let savedChars = 0;
  let savedTokens = 0;
  let compressedCount = 0;

  const result: Message[] = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;

    let modified = false;
    const newContent: ContentBlock[] = msg.content.map((block, bi) => {
      const key = `${mi}:${bi}`;
      if (compressSet.has(key)) {
        modified = true;
        compressedCount++;
        const originalText = typeof block.content === 'string' ? block.content : '';
        savedChars += originalText.length - cfg.placeholder.length;
        savedTokens += Math.max(0, estimateTokensForText(originalText) - placeholderTokens);
        return { ...block, content: cfg.placeholder };
      }
      return block;
    });

    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, compressedCount, savedChars, savedTokens };
}
