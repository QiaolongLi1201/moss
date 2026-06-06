/**
 * 失效旧读取结果 — 针对可变文件的 micro-compaction：文件被再次读或写时，较早的
 * 读取结果不再可信，应从上下文中清除以防模型依赖过时数据。
 *
 * 当同一文件被后续写操作（本机 write/write_file/edit/edit_file 或设备 device_file_write）
 * 覆盖后，历史中更早的读取（read/read_file/device_file_read）的 tool_result 内容已不可靠，
 * 替换为短占位以回收 token。本机文件工具有两套命名 —— 宿主 read/write/edit 与 moss-CLI
 * builtin read_file/write_file/edit_file —— 两者都需识别，否则纯 builtin 运行时永不触发。
 */

import type { Message } from '../core/session/session-jsonl.js';
import { estimateTokensForText } from './tokens.js';

const READ_RESULT_TOOLS = new Set(['read', 'read_file', 'device_file_read']);
const MUTATE_RESULT_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'device_file_write']);

export const STALE_READ_PLACEHOLDER =
  '[已省略：该路径在后续已被写入或编辑，旧读取结果不再可靠。必要时请重新 read / device_file_read。]';

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

/**
 * 提取同一文件的路径键，兼容两套运行时命名 —— 宿主 (read/write/edit，参数 file_path)
 * 与 moss-CLI builtin (read_file/write_file/edit_file，参数 path) —— 归一到同一 ws: 键；
 * 设备 (device_file_read/device_file_write，参数 path) 归一到 dev: 键。
 */
export function toolPathKey(toolName: string, input: Record<string, unknown>): string | null {
  if (
    toolName === 'read' ||
    toolName === 'read_file' ||
    toolName === 'write' ||
    toolName === 'write_file' ||
    toolName === 'edit' ||
    toolName === 'edit_file'
  ) {
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

// ── 重复读取去重（FILE_UNCHANGED）────────────────────────────────────────────
// 补全本文件开头声明却缺失的另一半：「文件被再次读取时，较早的读取结果」可回收。
// 当同一文件在历史中被多次 read 且某次读取的内容与**更晚一次**逐字相同时，较早那
// 份纯属冗余 —— 保留最新全文、把更早的相同读取折叠成占位符即可零信息损失地回收
// token。判据用「内容逐字相等」而非 mtime/范围解析：相同字节即代表更晚那份权威且
// 等价，无论其间是否发生过写入（read→write→content-differs 由上面的 stale 逻辑负责）。
// 因为永远保留最新全文，本机制对压缩天然安全（不会产生指向已被清除内容的悬空占位）。

export const FILE_UNCHANGED_PLACEHOLDER =
  '[已省略：该文件后续被再次读取且内容完全一致，完整内容见下方较新的读取结果，无需重复保留。]';

/** 读取类工具名：本机 read_file、宿主 read、设备 device_file_read。 */
const DEDUP_READ_TOOLS = new Set(['read', 'read_file', 'device_file_read']);

/**
 * 为去重提取同一文件的路径键，兼容本机 (read/read_file，参数 file_path 或 path) 与
 * 设备 (device_file_read，参数 path) 两套命名，归一到与 stale 逻辑一致的 ws:/dev: 键。
 */
function dedupReadPathKey(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'read' || toolName === 'read_file') {
    const raw =
      typeof input.file_path === 'string'
        ? input.file_path
        : typeof input.path === 'string'
          ? input.path
          : null;
    return raw ? `ws:${normalizePathKey(raw)}` : null;
  }
  if (toolName === 'device_file_read') {
    const raw = typeof input.path === 'string' ? input.path : null;
    return raw ? `dev:${normalizePathKey(raw)}` : null;
  }
  return null;
}

/** tool_use_id → { 工具名, 去重路径键 }，覆盖 read_file 等本机命名（与 buildToolUseIdMap 互补）。 */
function buildReadKeyByToolUseId(
  messages: Message[],
): Map<string, { name: string; key: string | null }> {
  const map = new Map<string, { name: string; key: string | null }>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.id || !block.name) continue;
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
        string,
        unknown
      >;
      map.set(block.id, { name: block.name, key: dedupReadPathKey(block.name, input) });
    }
  }
  return map;
}

/**
 * 将同一文件「内容与更晚一次读取逐字相同」的较早读取结果替换为占位符。
 * 不修改原数组：返回新数组副本（仅替换涉及的消息块）。永远保留每个 (路径,内容) 的
 * 最后一次出现，因此对后续压缩安全。返回结构与 invalidateStaleReadToolResults 一致，
 * 便于调用方按同一 context_action 汇总。
 */
export function dedupeUnchangedReadToolResults(messages: Message[]): StaleReadInvalidateResult {
  const idMap = buildReadKeyByToolUseId(messages);

  type ReadRef = { msgIdx: number; blockIdx: number; key: string; content: string };
  const reads: ReadRef[] = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    for (let blockIdx = 0; blockIdx < msg.content.length; blockIdx++) {
      const block = msg.content[blockIdx];
      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
      const meta = idMap.get(block.tool_use_id);
      if (!meta || !DEDUP_READ_TOOLS.has(meta.name) || !meta.key) continue;
      if (typeof block.content !== 'string') continue;
      const content = block.content;
      if (content === STALE_READ_PLACEHOLDER || content === FILE_UNCHANGED_PLACEHOLDER) continue;
      reads.push({ msgIdx, blockIdx, key: meta.key, content });
    }
  }
  if (reads.length < 2) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  // 倒序遍历，使每个 (key, content) 的**最后一次**出现永不入选；其更早的逐字相同副本入选。
  const toStub = new Set<string>();
  const seenLater = new Map<string, Set<string>>();
  for (let i = reads.length - 1; i >= 0; i--) {
    const ref = reads[i];
    const seen = seenLater.get(ref.key);
    if (seen?.has(ref.content) && ref.content.length > FILE_UNCHANGED_PLACEHOLDER.length) {
      toStub.add(`${ref.msgIdx}:${ref.blockIdx}`);
    }
    if (seen) seen.add(ref.content);
    else seenLater.set(ref.key, new Set([ref.content]));
  }

  if (toStub.size === 0) {
    return { messages, invalidatedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  const placeholderTokens = estimateTokensForText(FILE_UNCHANGED_PLACEHOLDER);
  let invalidatedCount = 0;
  let savedChars = 0;
  let savedTokens = 0;
  const result: Message[] = messages.map((msg, msgIdx) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg;

    let touched = false;
    const newContent = msg.content.map((block, blockIdx) => {
      const id = `${msgIdx}:${blockIdx}`;
      if (!toStub.has(id)) return block;
      if (block.type !== 'tool_result') return block;
      const prev = typeof block.content === 'string' ? block.content : '';
      touched = true;
      invalidatedCount++;
      savedChars += Math.max(0, prev.length - FILE_UNCHANGED_PLACEHOLDER.length);
      savedTokens += Math.max(0, estimateTokensForText(prev) - placeholderTokens);
      return { ...block, content: FILE_UNCHANGED_PLACEHOLDER };
    });

    return touched ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, invalidatedCount, savedChars, savedTokens };
}
