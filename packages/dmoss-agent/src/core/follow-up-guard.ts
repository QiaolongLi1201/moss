/**
 * Follow-up tool guard — detects when another LLM turn is needed to
 * process pending tool results, and when the LLM's text output describes
 * actions it should have performed via tools.
 *
 * Two complementary checks:
 *
 * 1. **Tool-result follow-up** (`lastMessageNeedsToolFollowUp`):
 *    After tool execution, the conversation ends with a user message
 *    containing `tool_result` blocks.  The LLM must read those results
 *    and decide next steps — so we continue the loop.
 *
 * 2. **Text-action follow-up** (`detectUnexecutedToolIntents`):
 *    The LLM says "I'll run …" / "Let me read …" without actually emitting
 *    `tool_use` blocks.  We inject a gentle nudge to re-engage tool use.
 */

import type { LLMMessage, LLMContentBlock } from './llm-provider.js';
import { stripThinkingTagsKeepVisible } from './inline-thinking-stream.js';
import {
  CHINESE_PLAN_NEGATION_BEFORE_RE,
  CHINESE_PLAN_TOOL_INVOCATION_RE,
  NOISE_PLANNED_TOOL_NAMES,
} from '../prompts/plan-detection.js';

/** 与 session-jsonl `Message` / provider `LLMMessage` 兼容的最小结构（仅作 tool_use 扫描） */
type MessageLike = { role: string; content: unknown };

/**
 * 提取 `<thinking>` / `<redacted_thinking>` / `<think>` 内正文（不含标签），
 * 用于「仅流式了思考、可见正文为空」时的跟进扫描。
 *
 * 与 `inline-thinking-stream.ts` 的 `THINK_TAG_DEFS` 保持一致：历史上这里漏掉了短形 `<think>`，
 * 导致 doubao/qwen 等「只给 thinking、不给 text_delta」模型把工具计划包在 `<think>` 里时，
 * follow-up 检测拿不到规划文本，最终既不注入 tool_use 也不继续循环，表现为「说要调用工具但没调用」。
 */
export function extractThinkingTagBodies(raw: string): string {
  const s = String(raw || '');
  if (!s.trim()) return '';
  const re = /<(?:thinking|redacted_thinking|think)(?:\s[^>]*)?>([\s\S]*?)<\/(?:thinking|redacted_thinking|think)>/gi;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const inner = m[1]?.trim();
    if (inner) parts.push(inner);
  }
  return parts.join('\n');
}

function joinAssistantTextBlocks(last: LLMMessage): string {
  if (typeof last.content === 'string') return last.content;
  return (last.content as LLMContentBlock[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ─── 1. Tool-result follow-up ───────────────────────────────────

/**
 * Returns `true` when the last message in `messages` is a user message
 * that contains at least one `tool_result` block — meaning the LLM has
 * not yet processed the results of the previous tool calls.
 */
export function lastMessageNeedsToolFollowUp(messages: readonly MessageLike[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  if (typeof last.content === 'string') return false;
  return (last.content as LLMContentBlock[]).some((b) => b.type === 'tool_result');
}

/**
 * Returns true only for an active tool-result follow-up: the conversation tail
 * is still the tool_result message that the model has not summarized yet.
 *
 * This is intentionally stricter than "any assistant in history has
 * tool_use". Once the model has already produced a final assistant message
 * after reading tool results, future normal user turns must be allowed to use
 * the provider's configured reasoning mode again.
 */
export function hasToolResultAfterLastAssistant(messages: readonly MessageLike[]): boolean {
  return lastMessageNeedsToolFollowUp(messages);
}

/**
 * 是否应在此次 LLM 请求中**省略** pi-ai `reasoning`（与 `reasoning: null` 同义）。
 *
 * 部分 OpenAI 兼容网关在「工具结果跟进轮」同时开启 thinking/reasoning 时会返回
 * `400 The reasoning_content ... thinking mode`（被 {@link classifyProviderError} 标为
 * context_corruption）。可靠信号是：最后一个 assistant 之后仍存在 `tool_result`。
 * 已经由模型读完工具结果并产生最终 assistant 文本后，不再压制后续正常轮次的 reasoning。
 */
export function shouldSuppressReasoningForToolFollowUpRound(messages: readonly MessageLike[]): boolean {
  return hasToolResultAfterLastAssistant(messages);
}

// ─── 2. Text-action follow-up ───────────────────────────────────

export interface FollowUpPattern {
  /** Pattern matched against assistant text (case-insensitive) */
  pattern: RegExp;
  /** Suggested tool the LLM should have used */
  expectedTool: string;
  /** Nudge message to inject */
  guidance: string;
}

export interface TextActionFollowUp {
  matchedPattern: string;
  expectedTool: string;
  guidance: string;
}

/**
 * 在「上一条 user 已是 tool_result、且对应 assistant 已调用过 expectedTool」时，
 * 模型仍可能复读「应该先调用 xxx」的规划文案；此时不应再注入 follow_up，否则会同一工具连打。
 */
export function hasCompletedToolCallRecently(
  messages: LLMMessage[],
  toolName: string,
  lookback = 12,
): boolean {
  const start = Math.max(0, messages.length - lookback);
  for (let i = messages.length - 2; i >= start; i--) {
    const userMsg = messages[i];
    if (userMsg.role !== 'user' || typeof userMsg.content === 'string') continue;
    const ublocks = userMsg.content as LLMContentBlock[];
    if (!ublocks.some((b) => b.type === 'tool_result')) continue;
    const asst = messages[i - 1];
    if (!asst || asst.role !== 'assistant' || typeof asst.content === 'string') continue;
    const used = (asst.content as LLMContentBlock[]).some(
      (b): b is Extract<LLMContentBlock, { type: 'tool_use' }> => b.type === 'tool_use' && b.name === toolName,
    );
    if (used) return true;
  }
  return false;
}

/**
 * 中文规划里「要调用 xxx」常见的 snake_case 工具名。
 *
 * **保守策略**：只匹配明确的行动承诺（与 `CHINESE_PLAN_TOOL_INVOCATION_RE` 一致）。
 *
 * - 第一人称：「我来/我要/我去/我将/我先/让我」— 模型直接宣称自己会做。
 * - 顺序/流程词：「然后/接下来/最后/下一步/下面/紧接着/紧接下来/首先/随后」— 模型在规划里把工具调用作为一步列出；
 *   配合紧接的「调用 xxx」大多是「打算做、尚未做」的表达。
 *
 * 故意排除的词：
 * - 「应该/需要/必须/现在」— 多出现在解释性/劝说性文本（"按规则现在应该调用 X 工具"），不构成行动承诺；
 *   原单测明确要求这类文本不触发，扩展正则时保留此边界。
 *
 * 若模型只输出思考链（没有明确以第一人称或流程词起头地声明要调用工具），上游仍须真正发出 tool_calls，
 * 不走 host 意图注入兜底——避免把「在讨论工具怎么用」误当成「要立刻调用」。
 */
export function extractPlannedToolNamesFromChineseText(text: string): string[] {
  if (text.length > 800) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    CHINESE_PLAN_TOOL_INVOCATION_RE.source,
    CHINESE_PLAN_TOOL_INVOCATION_RE.flags,
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const low = raw.toLowerCase();
    if (NOISE_PLANNED_TOOL_NAMES.has(low)) continue;
    if (low.length < 3) continue;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    if (CHINESE_PLAN_NEGATION_BEFORE_RE.test(before)) continue;
    if (!seen.has(low)) {
      seen.add(low);
      out.push(raw);
    }
  }
  return out;
}

const DEFAULT_PATTERNS: FollowUpPattern[] = [
  {
    pattern: /(?:let me|i(?:'ll| will)|going to)\s+(?:run|execute|exec)\b/i,
    expectedTool: 'exec',
    guidance:
      'You described running a command but did not use a tool. Please use the appropriate exec tool to actually execute it.',
  },
  {
    pattern: /(?:let me|i(?:'ll| will)|going to)\s+(?:read|check|look at|open)\s+(?:the\s+)?(?:file|content)/i,
    expectedTool: 'read',
    guidance:
      'You described reading a file but did not use a tool. Please use the read/file tool to retrieve the content.',
  },
  {
    pattern: /(?:let me|i(?:'ll| will)|going to)\s+(?:write|create|save|update)\s+(?:the\s+)?(?:file|config)/i,
    expectedTool: 'write',
    guidance:
      'You described writing a file but did not use a tool. Please use the write/edit tool to make the change.',
  },
];

/**
 * Scan the latest assistant message for text that describes tool actions
 * the LLM should have executed.  Returns matched follow-ups (empty if none).
 *
 * @param maxFollowUps Cap on the number of nudges returned per evaluation (default 1).
 */
export function detectUnexecutedToolIntents(
  messages: LLMMessage[],
  extraPatterns?: FollowUpPattern[],
  maxFollowUps = 1,
): TextActionFollowUp[] {
  if (messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant') return [];

  const hasToolUse =
    typeof last.content !== 'string' &&
    (last.content as LLMContentBlock[]).some((b) => b.type === 'tool_use');
  if (hasToolUse) return [];

  let text =
    typeof last.content === 'string'
      ? stripThinkingTagsKeepVisible(last.content)
      : (last.content as LLMContentBlock[])
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .map((t) => stripThinkingTagsKeepVisible(t))
          .join('\n');

  /**
   * 若 strip 后可见正文为空，但助手块里仍有思考标签（常见于 Qwen：只流式 thinking、无 text_delta），
   * 用语义仅在思考区内的文案做跟进检测。若可见已有内容则仍以可见为准，避免与
   * 「忽略包在 thinking 标签里的工具计划文案」单测冲突。
   */
  if (!text.trim()) {
    const rawJoined = joinAssistantTextBlocks(last);
    const thinkingOnly = extractThinkingTagBodies(rawJoined);
    if (thinkingOnly.trim()) {
      text = thinkingOnly;
    }
  }

  if (!text.trim()) return [];

  const patterns = [...DEFAULT_PATTERNS, ...(extraPatterns ?? [])];
  const results: TextActionFollowUp[] = [];

  for (const p of patterns) {
    if (results.length >= maxFollowUps) break;
    if (!p.pattern.test(text)) continue;
    if (hasCompletedToolCallRecently(messages, p.expectedTool)) continue;
    results.push({
      matchedPattern: p.pattern.source,
      expectedTool: p.expectedTool,
      guidance: p.guidance,
    });
  }

  for (const toolName of extractPlannedToolNamesFromChineseText(text)) {
    if (results.length >= maxFollowUps) break;
    if (hasCompletedToolCallRecently(messages, toolName)) continue;
    if (results.some((r) => r.expectedTool === toolName)) continue;
    results.push({
      matchedPattern: 'chinese-plan-tool-invoke',
      expectedTool: toolName,
      guidance:
        `You planned to call ${toolName} in text but did not emit a tool call. ` +
        `Invoke ${toolName} now with valid JSON arguments per its schema. Do not repeat the plan.`,
    });
  }

  return results;
}

export interface FollowUpGuardConfig {
  enabled: boolean;
  /** Extra patterns beyond the built-in set */
  extraPatterns?: FollowUpPattern[];
  /** Max follow-up nudges per turn (default 1) */
  maxFollowUps?: number;
  /** Max consecutive follow-up turns before giving up (prevents infinite nudge loops) */
  maxConsecutiveFollowUps?: number;
}

export const DEFAULT_FOLLOW_UP_GUARD_CONFIG: FollowUpGuardConfig = {
  enabled: true,
  maxFollowUps: 1,
  maxConsecutiveFollowUps: 1,
};
