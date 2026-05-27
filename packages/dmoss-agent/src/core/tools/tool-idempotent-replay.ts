/**
 * 通用「重复工具调用」短路：对**假定无会话外副作用**的工具，若历史里已有
 * 同名 + 同参的成功 tool_result，则复用正文，避免 reasoning 模型连打。
 *
 * 采用**块名单**（mutating）：凡未列入且未匹配前缀者，均允许重放推断。
 */

import type { LLMMessage, LLMContentBlock } from '../llm/llm-provider.js';

/** Built-in mutating tool names that must never replay cached results */
const BUILTIN_MUTATING_EXACT = new Set<string>([
  'device_exec',
  'exec',
  'memory_write',
  'memory_save',
  'web_search',
  'write_file',
  'ros2_service_call',
  'ros2_launch',
]);

/** Built-in mutating tool prefixes */
const BUILTIN_MUTATING_PREFIXES = [
  'device_file_write',
  'device_file_delete',
  'device_file_upload',
];

/** Host-registered additional mutating exact names */
const hostMutatingExact = new Set<string>();
/** Host-registered additional mutating prefixes */
const hostMutatingPrefixes: string[] = [];

/**
 * Register additional mutating tool names/prefixes from the host application.
 * Called once at startup via the bridge layer.
 */
export function registerMutatingToolHints(hints: {
  exact?: string[];
  prefixes?: string[];
}): void {
  if (hints.exact) for (const n of hints.exact) hostMutatingExact.add(n);
  if (hints.prefixes) hostMutatingPrefixes.push(...hints.prefixes);
}

export function isToolAssumedMutating(toolName: string): boolean {
  const n = String(toolName || '').trim();
  if (!n) return true;
  if (BUILTIN_MUTATING_EXACT.has(n) || hostMutatingExact.has(n)) return true;
  return [...BUILTIN_MUTATING_PREFIXES, ...hostMutatingPrefixes].some((p) => n.startsWith(p));
}

/** Stable serialization of tool input with recursive key sorting */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${pairs.join(',')}}`;
}

export function stableSerializeToolInput(input: Record<string, unknown>): string {
  return stableStringify(input);
}

export function toolInputsReplayEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableSerializeToolInput(a) === stableSerializeToolInput(b);
}

/**
 * 在历史消息中查找与 (toolName, input) 一致的上一次**成功** tool_result 正文。
 * @param messages 不含当前正在执行的那条 assistant
 */
export function findReplayableToolResultContent(
  messages: LLMMessage[],
  toolName: string,
  input: Record<string, unknown>,
  lookback = 32,
): string | null {
  if (isToolAssumedMutating(toolName)) return null;

  const want = stableSerializeToolInput(input);
  const start = Math.max(0, messages.length - lookback);

  for (let i = messages.length - 1; i >= 1; i--) {
    if (i < start) break;
    const userMsg = messages[i];
    if (userMsg.role !== 'user' || typeof userMsg.content === 'string') continue;
    const ublocks = userMsg.content as LLMContentBlock[];
    const results = ublocks.filter(
      (b): b is { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean } =>
        b.type === 'tool_result',
    );
    if (results.length === 0) continue;
    const asst = messages[i - 1];
    if (!asst || asst.role !== 'assistant' || typeof asst.content === 'string') continue;
    const uses = (asst.content as LLMContentBlock[]).filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    );
    for (const tr of results) {
      if (tr.is_error) continue;
      const tu = uses.find((u) => u.id === tr.tool_use_id);
      if (!tu || tu.name !== toolName) continue;
      const prevIn =
        tu.input && typeof tu.input === 'object' && !Array.isArray(tu.input)
          ? (tu.input as Record<string, unknown>)
          : {};
      if (stableSerializeToolInput(prevIn) !== want) continue;
      const body = String(tr.content || '').trim();
      if (body) return tr.content;
    }
  }
  return null;
}
