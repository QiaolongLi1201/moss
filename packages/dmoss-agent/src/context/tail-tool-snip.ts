/**
 * 近尾段超长 tool_result 截断
 *
 * microcompact 会保留最近 N 条 tool_result 全文；多轮大文件读取时，这 N 条可能仍占满上下文。
 * 在「软压力」下对**紧靠硬保留区之前**的一小批结果做超阈值单行截断，给长任务挤出窗口。
 */

import type { Message, ContentBlock } from "../core/session-jsonl.js";
import { estimateTokensForText } from "./tokens.js";

export interface TailToolSnipConfig {
  /** 末尾几条绝对不碰（与 agent 侧 microcompact 硬保留对齐） */
  hardKeepLatest: number;
  /** 紧挨硬保留区之前再扫几处分块（仅超长截断） */
  softBand: number;
  /** 超过此字符数才截断 */
  maxChars: number;
}

export const DEFAULT_TAIL_SNIP_CONFIG: TailToolSnipConfig = {
  hardKeepLatest: 2,
  softBand: 8,
  maxChars: 12_000,
};

export interface TailToolSnipResult {
  messages: Message[];
  snippedCount: number;
  /** 相对短截断行多回收的字符数（物理量） */
  savedChars: number;
  /** 相对短截断行多回收的 token 估算（用户可见文案的主单位） */
  savedTokens: number;
}

function shortSnipLine(toolName?: string): string {
  const n = toolName?.trim() || "tool";
  return `[超长输出已省略 · ${n}；若仍需原文请在本轮再调用该工具。]`;
}

/**
 * 仅截断「倒数第 (hardKeepLatest+1) … (hardKeepLatest+softBand)」条中超长的 tool_result。
 */
export function snipTailOversizedToolResults(
  messages: Message[],
  config: Partial<TailToolSnipConfig> = {},
): TailToolSnipResult {
  const cfg = { ...DEFAULT_TAIL_SNIP_CONFIG, ...config };

  const allToolResults: Array<{ msgIdx: number; blockIdx: number; content: string; name?: string }> =
    [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (typeof msg.content === "string") continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;
      allToolResults.push({
        msgIdx: mi,
        blockIdx: bi,
        content: block.content,
        name: typeof block.name === "string" ? block.name : undefined,
      });
    }
  }

  if (allToolResults.length <= cfg.hardKeepLatest) {
    return { messages, snippedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const n = allToolResults.length;
  const bandStart = Math.max(0, n - cfg.hardKeepLatest - cfg.softBand);
  const bandEnd = n - cfg.hardKeepLatest;

  const snipKeys = new Set<string>();
  let wouldSnip = 0;
  let savedChars = 0;
  let savedTokens = 0;

  for (let i = bandStart; i < bandEnd; i++) {
    const tr = allToolResults[i];
    if (tr.content.length < cfg.maxChars) continue;
    const line = shortSnipLine(tr.name);
    if (tr.content === line) continue;
    snipKeys.add(`${tr.msgIdx}:${tr.blockIdx}`);
    wouldSnip++;
    savedChars += tr.content.length - line.length;
    savedTokens += Math.max(
      0,
      estimateTokensForText(tr.content) - estimateTokensForText(line),
    );
  }

  if (wouldSnip === 0) {
    return { messages, snippedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  let snippedCount = 0;
  const result: Message[] = messages.map((msg, mi) => {
    if (typeof msg.content === "string") return msg;
    let modified = false;
    const newContent: ContentBlock[] = msg.content.map((block, bi) => {
      const key = `${mi}:${bi}`;
      if (!snipKeys.has(key) || block.type !== "tool_result") return block;
      const line = shortSnipLine(block.name);
      modified = true;
      snippedCount++;
      return { ...block, content: line };
    });
    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, snippedCount, savedChars, savedTokens };
}
