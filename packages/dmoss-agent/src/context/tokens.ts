import type { ContentBlock, Message } from "../core/session/session-jsonl.js";

export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * CJK character detection via charCode ranges — avoids per-character regex
 * overhead. Token estimation is called on every message in the context window,
 * so this is a hot path worth optimizing.
 */
function isCJK(code: number): boolean {
  return (code >= 0x3000 && code <= 0x9fff) ||
         (code >= 0xac00 && code <= 0xd7af) ||
         (code >= 0xff00 && code <= 0xffef);
}

/** 导出供系统提示与窗口经济学做 token 估算（CJK-aware） */
export function estimateTokensForText(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCJK(text.charCodeAt(i))) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars / 1.5) + Math.ceil(otherChars / 4);
}

function estimateBlockChars(block: ContentBlock): number {
  if (block.type === "text") {
    return block.text?.length ?? 0;
  }
  if (block.type === "tool_use") {
    const base = block.name?.length ?? 0;
    try {
      const input = block.input ? JSON.stringify(block.input) : "";
      return base + input.length + 16;
    } catch {
      return base + 128;
    }
  }
  if (block.type === "tool_result") {
    return block.content?.length ?? 0;
  }
  return 0;
}

function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === "text") {
    return estimateTokensForText(block.text ?? "");
  }
  if (block.type === "tool_result") {
    // tool_result 内容可能包含中文（如设备端命令输出），使用精确估算
    return estimateTokensForText(block.content ?? "");
  }
  // tool_use 的 input 通常是 JSON（英文为主），使用字符数估算
  return Math.max(1, Math.ceil(estimateBlockChars(block) / CHARS_PER_TOKEN_ESTIMATE));
}

export function estimateMessageChars(message: Message): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockChars(block);
  }
  return total;
}

export function estimateMessagesChars(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);
}

export function estimateMessageTokens(message: Message): number {
  if (typeof message.content === "string") {
    return Math.max(1, estimateTokensForText(message.content));
  }
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockTokens(block);
  }
  return Math.max(1, total);
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * 每「上下文窗口单位」对应多少字符用于与厂商「输入长度」对齐。
 * 默认 4（与 CHARS_PER_TOKEN_ESTIMATE 一致）。
 * 设为 1 时：按「原始字符数 ≈ 窗口上限」计量（如部分网关 max length 与 context 同阶）。
 * 环境变量：`DMOSS_CONTEXT_CHARS_PER_TOKEN_UNIT`。
 */
export function resolveContextCharsPerTokenUnit(): number {
  const raw = process.env.DMOSS_CONTEXT_CHARS_PER_TOKEN_UNIT?.trim();
  if (!raw || !String(raw).trim()) return CHARS_PER_TOKEN_ESTIMATE;
  const n = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n)) return CHARS_PER_TOKEN_ESTIMATE;
  return Math.min(8, Math.max(1, n));
}

/**
 * 与窗口经济学比较用的「等效占用」：取 tokenizer 估算与 字符/单位 换算的较大值，
 * 避免英文偏多时低估、或厂商按字符计数时漏触发主动压缩。
 *
 * 当传入 effectiveContextWindowTokens 且 原始字符数已占有效窗口比例很高时，再与 rawChars 取 max，
 * 对齐「Input length 148911 exceeds maximum 131072」类按字符计的上限（无需用户改 unit 也能提前 compact）。
 */
export function estimatePromptUnitsForContextWindow(params: {
  messages: Message[];
  systemPrompt: string;
  charsPerTokenUnit: number;
  effectiveContextWindowTokens?: number;
}): number {
  const estTokens =
    estimateMessagesTokens(params.messages) + estimateTokensForText(params.systemPrompt);
  const rawChars =
    estimateMessagesChars(params.messages) + (params.systemPrompt?.length ?? 0);
  const unit = Math.max(1, params.charsPerTokenUnit);
  const fromChars = rawChars / unit;
  let score = Math.max(estTokens, fromChars);
  const cap = params.effectiveContextWindowTokens;
  // Only apply the raw-chars safeguard when charsPerTokenUnit ≈ 1
  // (character-counting mode). For token-counting gateways (unit=4),
  // rawChars is 3-4× larger than cap and would fire prematurely.
  if (unit <= 1.5 && cap !== undefined && cap > 0 && rawChars / cap >= 0.85) {
    score = Math.max(score, rawChars);
  }
  return score;
}
