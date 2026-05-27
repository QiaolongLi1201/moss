/**
 * 消息格式转换: 内部 Message[] → pi-ai Message[]
 *
 * pi-ai 使用三种 role: "user" / "assistant" / "toolResult"
 * 内部格式: role 只有 "user" / "assistant"，tool_result 嵌在 user 消息的 content 中
 *
 * `Message.thinking` is persisted separately from visible assistant text. For
 * OpenAI-compatible thinking gateways, the prior assistant reasoning must stay
 * in the assistant history as `reasoning_content`; otherwise providers such as
 * DeepSeek reject the next request. Non-thinking models still omit it except for
 * the active unresolved tool-result follow-up compatibility path.
 */

import type { Message } from '../session/session-jsonl.js';
import type {
  Message as PiMessage,
  TextContent as PiTextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
} from '../../provider/pi-ai-types.js';

type RoundTripContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
};

type ThinkingRoundTripMessage = {
  role: string;
  content: string | RoundTripContentBlock[];
  thinking?: string[];
};

function createEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toolUseIds(message: ThinkingRoundTripMessage): Set<string> {
  const out = new Set<string>();
  if (typeof message.content === 'string') return out;
  for (const block of message.content) {
    if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id.trim()) {
      out.add(block.id);
    }
  }
  return out;
}

function collectToolResultIds(message: ThinkingRoundTripMessage, out: Set<string>): void {
  if (message.role !== 'user' || typeof message.content === 'string') return;
  for (const block of message.content) {
    if (
      block?.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      block.tool_use_id.trim()
    ) {
      out.add(block.tool_use_id);
    }
  }
}

function toolResultIdsAfterAssistant(
  messages: readonly ThinkingRoundTripMessage[],
  index: number,
): Set<string> {
  const out = new Set<string>();
  for (let i = index + 1; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role === 'assistant') break;
    collectToolResultIds(msg, out);
  }
  return out;
}

export function shouldRoundTripAssistantThinking(
  messages: readonly ThinkingRoundTripMessage[],
  index: number,
  options: { thinkingMode?: boolean } = {},
): boolean {
  const current = messages[index];
  const next = messages[index + 1];
  if (!current || !next) return false;
  if (current.role !== 'assistant') return false;
  if (!Array.isArray(current.thinking) || current.thinking.length === 0) return false;
  if (options.thinkingMode) return true;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === 'assistant') return false;
  }

  const callIds = toolUseIds(current);
  if (callIds.size === 0) return false;

  const resultIds = toolResultIdsAfterAssistant(messages, index);
  if (resultIds.size === 0) return false;
  return [...resultIds].some((id) => callIds.has(id));
}

function pushThinkingIfNeeded(
  out: (PiTextContent | ThinkingContent | PiToolCall)[],
  msg: Message,
  includeThinking: boolean,
): void {
  if (!includeThinking) return;
  const joined = msg.thinking?.filter(Boolean).join('\n\n').trim();
  if (!joined) return;
  out.push({
    type: 'thinking',
    thinking: joined,
    thinkingSignature: 'reasoning_content',
  });
}

/**
 * 将内部 Message[] 转换为 pi-ai 的 Message[]
 *
 * 转换规则:
 * - user + string content → PiUserMessage
 * - user + ContentBlock[] 含 tool_result → 拆分为独立 PiToolResultMessage
 * - user + ContentBlock[] 含 text → PiUserMessage
 * - assistant + ContentBlock[] → PiAssistantMessage（tool_use → ToolCall）
 */
export function convertMessagesToPi(
  messages: Message[],
  modelInfo: { api: string; provider: string; id: string; reasoning?: unknown },
): PiMessage[] {
  const result: PiMessage[] = [];
  const thinkingMode =
    modelInfo.reasoning !== undefined &&
    modelInfo.reasoning !== null &&
    modelInfo.reasoning !== false &&
    modelInfo.reasoning !== '';

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({
          role: 'user',
          content: msg.content,
          timestamp: msg.timestamp,
        });
        continue;
      }

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          result.push({
            role: 'user',
            content: [{ type: 'text', text: block.text }],
            timestamp: msg.timestamp,
          });
        } else if (block.type === 'tool_result') {
          result.push({
            role: 'toolResult',
            toolCallId: block.tool_use_id ?? '',
            toolName: block.name ?? '',
            content: [
              { type: 'text', text: typeof block.content === 'string' ? block.content : '' },
            ],
            isError: block.is_error ?? false,
            timestamp: msg.timestamp,
          });
        }
      }
    } else {
      // assistant
      const includeThinking = shouldRoundTripAssistantThinking(messages, index, { thinkingMode });
      if (typeof msg.content === 'string') {
        const parts: (PiTextContent | ThinkingContent)[] = [];
        pushThinkingIfNeeded(parts, msg, includeThinking);
        parts.push({ type: 'text', text: msg.content });
        result.push({
          role: 'assistant',
          content: parts,
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage: createEmptyUsage(),
          stopReason: 'stop',
          timestamp: msg.timestamp,
        });
        continue;
      }

      const piContent: (PiTextContent | ThinkingContent | PiToolCall)[] = [];
      pushThinkingIfNeeded(piContent, msg, includeThinking);
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          piContent.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          piContent.push({
            type: 'toolCall',
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: block.input ?? {},
          });
        }
      }

      result.push({
        role: 'assistant',
        content: piContent,
        api: modelInfo.api,
        provider: modelInfo.provider,
        model: modelInfo.id,
        usage: createEmptyUsage(),
        stopReason: 'stop',
        timestamp: msg.timestamp,
      });
    }
  }

  return result;
}
