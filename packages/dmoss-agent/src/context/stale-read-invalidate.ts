/**
 * 失效旧读取结果 — 针对可变文件的 micro-compaction：文件被再次读或写时，较早的
 * 读取结果不再可信，应从上下文中清除以防模型依赖过时数据。
 *
 * 当同一文件在本机或设备上被 write/edit/device_file_write 之后，历史中更早的
 * read / device_file_read 的 tool_result 内容已不可靠，替换为短占位以回收 token。
 */

import type { Message } from '../core/session-jsonl.js';
import { estimateTokensForText } from './tokens.js';

const READ_RESULT_TOOLS = new Set(['read', 'device_file_read']);
const MUTATE_RESULT_TOOLS = new Set(['write', 'edit', 'device_file_write']);

export const STALE_READ_PLACEHOLDER =
  '[已省略：该路径在后续已被写入或编辑，旧读取结果不再可靠。必要时请重新 read / device_file_read。]';

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

/** 本机 read/write/edit 用 file_path；设备读写用 path */
export function toolPathKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const raw =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : null;
    return raw ? `ws:${normalizePathKey(raw)}` : null;
  }
  if (toolName === 'device_file_read' || toolName === 'device_file_write') {
    const raw = typeof input.path === 'string' ? input.path : null;
    return raw ? `dev:${normalizePathKey(raw)}` : null;
  }
  return null;
}

function buildToolUseIdMap(messages: Message[]): Map<string, { name: string; key: string | null }> {
  const map = new Map<string, { name: string; key: string | null }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.id || !block.name) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
        string,
        unknown
      >;
      map.set(block.id, { name: block.name, key: toolPathKey(block.name, input) });
    }
  }
  return map;
}

type ToolResultEvent = {
  globalIdx: number;
  kind: 'read' | 'mutate';
  key: string;
  msgIdx: number;
  blockIdx: number;
  contentLen: number;
};

function collectToolResultEvents(messages: Message[]): ToolResultEvent[] {
  const idMap = buildToolUseIdMap(messages);
  const events: ToolResultEvent[] = [];
  let globalIdx = 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const meta = idMap.get(block.tool_use_id);
      if (!meta?.name) continue;
      const key = meta.key;
      if (!key) continue;

      if (READ_RESULT_TOOLS.has(meta.name)) {
        events.push({
          globalIdx,
          kind: 'read',
          key,
          msgIdx,
          blockIdx,
          contentLen: typeof block.content === 'string' ? block.content.length : 0,
        });
        globalIdx++;
      } else if (MUTATE_RESULT_TOOLS.has(meta.name)) {
        events.push({
          globalIdx,
          kind: 'mutate',
          key,
          msgIdx,
          blockIdx,
          contentLen: typeof block.content === 'string' ? block.content.length : 0,
        });
        globalIdx++;
      }
    }
  }

  return events;
}

export interface StaleReadInvalidateResult {
  messages: Message[];
  /** 被替换的 tool_result 条数 */
  invalidatedCount: number;
  /** 相对占位符多回收的字符数（物理量，便于排障与日志） */
  savedChars: number;
  /** 相对占位符多回收的 token 估算（CJK 感知；用户可见文案的主单位） */
  savedTokens: number;
}

/**
 * 将「在后续发生同路径写操作之后」的旧 read 结果替换为占位符。
 * 不修改原数组：返回新数组副本（仅替换涉及的消息块）。
 */
export function invalidateStaleReadToolResults(messages: Message[]): StaleReadInvalidateResult {
  const events = collectToolResultEvents(messages);
  if (events.length === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const mutateMaxByKey = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'mutate') continue;
    mutateMaxByKey.set(e.key, Math.max(mutateMaxByKey.get(e.key) ?? -1, e.globalIdx));
  }

  const toInvalidate = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'read') continue;
    const mx = mutateMaxByKey.get(e.key) ?? -1;
    if (mx > e.globalIdx) {
      toInvalidate.add(`${e.msgIdx}:${e.blockIdx}`);
    }
  }

  if (toInvalidate.size === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  /** 占位符固定，只算一次 token */
  const placeholderTokens = estimateTokensForText(STALE_READ_PLACEHOLDER);
  let invalidatedCount = 0;
  let savedChars = 0;
  let savedTokens = 0;
  const result: Message[] = messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;

    let touched = false;
    const newContent = msg.content.map((block, blockIdx) => {
      const key = `${msgIdx}:${blockIdx}`;
      if (!toInvalidate.has(key)) return block;
      if (block.type !== 'tool_result') return block;
      const prev = typeof block.content === 'string' ? block.content : '';
      if (prev === STALE_READ_PLACEHOLDER) return block;
      touched = true;
      invalidatedCount++;
      savedChars += Math.max(0, prev.length - STALE_READ_PLACEHOLDER.length);
      savedTokens += Math.max(0, estimateTokensForText(prev) - placeholderTokens);
      return { ...block, content: STALE_READ_PLACEHOLDER };
    });

    return touched ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, invalidatedCount, savedChars, savedTokens };
}
