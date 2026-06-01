import type { ToolContentBlock, ToolResultOutcome } from '../tools/tool-types.js';

// ============== 类型定义 ==============

/**
 * 消息结构
 * 与 Anthropic API 的 MessageParam 兼容
 */
export interface Message {
  /** 角色: user 或 assistant */
  role: "user" | "assistant";
  /** 内容: 可以是纯文本，也可以是多个内容块（包含工具调用） */
  content: string | ContentBlock[];
  /** 时间戳: 用于排序和调试 */
  timestamp: number;
  /**
   * Provider-native reasoning channel (Anthropic `thinking` blocks, OpenAI
   * Responses `reasoning` items, DeepSeek/Qwen `reasoning_content`, pi-ai
   * `thinking_delta` stream).
   *
   * Persisted for UI replay and **round-tripped** on OpenAI-compatible thinking
   * providers (see `message-convert.ts` / `PiAiLLMProvider.convertMessages`) as
   * provider-native reasoning history such as `reasoning_content`.
   *
   * Only assistant messages populate this field; legacy sessions and
   * messages from providers without a reasoning channel leave it undefined.
   */
  thinking?: string[];
}

/**
 * 内容块结构
 * 支持文本、工具调用、工具结果三种类型
 */
export interface ContentBlock {
  /** 类型 */
  type: "text" | "tool_use" | "tool_result";
  /** 文本内容 (type=text 时) */
  text?: string;
  /** 工具调用 ID (type=tool_use 时由 API 生成) */
  id?: string;
  /** 工具名称 (type=tool_use 时) */
  name?: string;
  /** 工具输入参数 (type=tool_use 时) */
  input?: Record<string, unknown>;
  /** 关联的工具调用 ID (type=tool_result 时) */
  tool_use_id?: string;
  /** 工具执行结果 (type=tool_result 时) */
  content?: string;
  /** 工具结果是否为错误 (type=tool_result 时) */
  is_error?: boolean;
  /** Terminal execution classification for audit/UI consumers (type=tool_result 时) */
  outcome?: ToolResultOutcome;
  /** Wall-clock execution time in milliseconds when known (type=tool_result 时) */
  durationMs?: number;
  /** Host-provided cancellation metadata for user/timeout aborts (type=tool_result 时) */
  aborted?: { by: 'user' | 'timeout' };
  /** Marks blocks synthesized by the agent to repair broken tool_use/tool_result pairs. Not a real tool invocation or result. */
  _synthetic?: "missing_tool_result" | "orphan_tool_use_repair";
  /** Structured content blocks from tools that return rich data (type=tool_result 时) */
  structuredContent?: ToolContentBlock[];
}

// ============== Session Entry 结构 ==============

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeaderEntry {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: Message;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type SessionEntry = MessageEntry | CompactionEntry;
export type SessionFileEntry = SessionHeaderEntry | SessionEntry;

// 摘要前缀/后缀
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export function createCompactionSummaryMessage(summary: string, timestamp?: string | number): Message {
  const resolvedTimestamp =
    typeof timestamp === "string"
      ? new Date(timestamp).getTime()
      : typeof timestamp === "number"
        ? timestamp
        : Date.now();
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Number.isFinite(resolvedTimestamp) ? resolvedTimestamp : Date.now(),
  };
}
