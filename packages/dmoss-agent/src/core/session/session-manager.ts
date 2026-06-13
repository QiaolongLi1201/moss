/**
 * 会话管理器 (Session Manager)
 *
 * 核心设计决策:
 *
 * 1. 为什么用 JSONL 而不是单个 JSON 文件？
 *    - JSONL (JSON Lines) 每行一条消息，追加写入
 *    - 优点: 写入是 O(1)，不需要读取整个文件再写回
 *    - 优点: 文件损坏时只影响单行，容错性更好
 *    - 优点: 可以用 tail -f 实时监控
 *
 * 2. 为什么用内存缓存 + 磁盘持久化（双写）？
 *    - 内存缓存: 避免每次 get() 都读磁盘，性能好
 *    - 磁盘持久化: Agent 重启后能恢复上下文
 *    - 写入时同时更新两者，保持一致性
 *
 * 3. 会话 Key 的安全处理
 *    - 用户可能传入恶意 sessionKey (如 "../../../etc/passwd")
 *    - 必须清理为安全的文件名
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireSessionWriteLock } from "./session-write-lock.js";
import { atomicWriteFile } from '../../utils/atomic-write.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  CURRENT_SESSION_VERSION,
  createCompactionSummaryMessage,
  type CompactionEntry,
  type Message,
  type MessageEntry,
  type SessionEntry,
  type SessionHeaderEntry,
} from './session-jsonl-types.js';
import { formatJsonlLine, loadSessionFile } from './session-jsonl-codec.js';

// ============== File Rotation ==============

/** Maximum session file size before rotation (50 MB). */
const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;

// ============== 会话管理器 ==============

export class SessionManager {
  /** 会话文件存储目录 */
  private baseDir: string;

  /** Session 缓存（避免重复加载/解析） */
  private states = new Map<string, SessionState>();

  /** 内存中最多保留的热会话数，防止 unique sessionKey 无限增长导致 OOM */
  private static readonly MAX_CACHED_SESSIONS = 100;
  /** Total approximate byte size cap for cached sessions. */
  private static readonly MAX_CACHED_SESSIONS_BYTES = 100 * 1024 * 1024;
  private sessionLastAccess = new Map<string, number>();
  private sessionApproxBytes = new Map<string, number>();
  private loadingPromises = new Map<string, Promise<SessionState>>();

  constructor(baseDir: string = "./.moss/sessions") {
    this.baseDir = baseDir;
  }

  private estimateStateBytes(state: SessionState): number {
    // Rough estimate: entries * average entry size
    return state.entries.length * 512; // ~512 bytes per entry average
  }

  private touchSessionKey(sessionKey: string, state?: SessionState) {
    this.sessionLastAccess.set(sessionKey, Date.now());
    if (state) {
      this.sessionApproxBytes.set(sessionKey, this.estimateStateBytes(state));
    }
  }

  private async evictSessionCacheIfNeeded() {
    const maxCount = SessionManager.MAX_CACHED_SESSIONS;
    const maxBytes = SessionManager.MAX_CACHED_SESSIONS_BYTES;

    let totalBytes = 0;
    for (const bytes of this.sessionApproxBytes.values()) totalBytes += bytes;

    if (this.states.size <= maxCount && totalBytes <= maxBytes) return;

    const byAccess = [...this.sessionLastAccess.entries()].sort((a, b) => a[1] - b[1]);
    let overCount = Math.max(0, this.states.size - maxCount);
    let overBytes = Math.max(0, totalBytes - maxBytes);

    for (const [key] of byAccess) {
      if (overCount <= 0 && overBytes <= 0) break;
      const evictState = this.states.get(key);
      if (evictState && !evictState.flushed) {
        // Don't evict sessions with unflushed data — try to flush first
        try {
          await rewriteSessionFile(evictState, this.baseDir);
        } catch {
          // flush before eviction failed — still evict to prevent unbounded memory growth
        }
      }
      const evictBytes = this.sessionApproxBytes.get(key) ?? 0;
      if (this.states.delete(key)) {
        this.sessionLastAccess.delete(key);
        this.sessionApproxBytes.delete(key);
        overCount--;
        overBytes -= evictBytes;
      }
    }
  }

  /**
   * 获取会话文件路径
   *
   * 安全处理: 使用 encodeURIComponent 编码 sessionKey
   * 防止路径注入攻击 (如 sessionKey = "../../../etc/passwd")
   */
  private getPath(sessionKey: string): string {
    const safeId = encodeURIComponent(sessionKey);
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  private getLegacyPath(sessionKey: string): string {
    const safeId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  private createHeader(): SessionHeaderEntry {
    return {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
  }

  /**
   * 加载会话历史
   *
   * 优先从内存缓存读取，缓存未命中时从磁盘加载
   * 这是典型的 Cache-Aside 模式
   */
  async load(sessionKey: string): Promise<Message[]> {
    const state = await this.ensureState(sessionKey);
    return buildSessionContext(state);
  }

  /**
   * 追加消息
   *
   * 双写策略:
   * 1. 先更新内存缓存（保证后续 get() 能立即读到）
   * 2. 再追加写入磁盘（保证持久化）
   *
   * 使用 fs.open('a') + write + sync 而不是 appendFile:
   * - fsync 确保数据落盘，防止进程崩溃时丢失
   * - 每条写入带 CRC8 校验，读取时验证完整性
   */
  async append(sessionKey: string, message: Message): Promise<void> {
    const state = await this.ensureState(sessionKey);

    const entry: MessageEntry = {
      type: "message",
      id: generateId(state.byId),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    const prevLeafId = state.leafId;
    const prevHasAssistant = state.hasAssistant;
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.messageIdByRef.set(message, entry.id);
    state.leafId = entry.id;
    if (message.role === "assistant") {
      state.hasAssistant = true;
    }
    try {
      await this.persistEntry(state, entry);
    } catch (err) {
      // Rollback in-memory state on disk failure to prevent divergence.
      state.entries.pop();
      state.byId.delete(entry.id);
      state.leafId = prevLeafId;
      state.hasAssistant = prevHasAssistant;
      // messageIdByRef is a WeakMap — the entry becomes unreachable and will be GC'd.
      throw err;
    }
  }

  /**
   * 重试/重新生成：从链尾删除连续 assistant 消息，使会话回到上一条 user 消息。
   * 不处理 compaction 叶（极少见）；若叶非 message 则 noop。
   */
  async truncateTrailingAssistant(sessionKey: string): Promise<boolean> {
    const state = await this.ensureState(sessionKey);
    if (state.leafId === null) return false;
    let changed = false;
    while (true) {
      const at = state.leafId;
      if (at === null) break;
      const leaf = state.byId.get(at);
      if (!leaf || leaf.type !== "message") break;
      if (leaf.message.role !== "assistant") break;
      const parentId = leaf.parentId;
      state.entries = state.entries.filter((e) => e.id !== leaf.id);
      state.byId.delete(leaf.id);
      state.leafId = parentId;
      changed = true;
    }
    if (!changed) return false;
    state.hasAssistant = state.entries.some(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    await rewriteSessionFile(state, this.baseDir);
    state.flushed = true;
    return true;
  }

  /**
   * 重新生成完整语义：从叶向根删除，直到叶为「与本轮锚点 user 内容一致」的 user 消息。
   * 锚点内容为 Agent 侧 skill 改写后的 processed user（与 append 时一致）。
   * 若链上找不到该 user，则退化为仅 `truncateTrailingAssistant`。
   */
  async truncateForRegenerate(sessionKey: string, anchorProcessedUserContent: string): Promise<boolean> {
    const anchor = anchorProcessedUserContent.trim();
    if (!anchor) {
      return this.truncateTrailingAssistant(sessionKey);
    }
    const msgStr = (m: Message): string => {
      const c = m.content;
      if (typeof c === "string") return c;
      return JSON.stringify(c);
    };
    const state = await this.ensureState(sessionKey);
    if (state.leafId === null) return false;

    let foundAnchor = false;
    {
      let cur: SessionEntry | undefined = state.byId.get(state.leafId);
      while (cur) {
        if (cur.type === "message" && cur.message.role === "user" && msgStr(cur.message).trim() === anchor) {
          foundAnchor = true;
          break;
        }
        cur = cur.parentId ? state.byId.get(cur.parentId) : undefined;
      }
    }
    if (!foundAnchor) {
      return this.truncateTrailingAssistant(sessionKey);
    }

    let changed = false;
    let guard = 0;
    const maxGuard = 4096;
    while (state.leafId !== null && guard++ < maxGuard) {
      const at = state.leafId;
      const leaf = state.byId.get(at);
      if (!leaf || leaf.type !== "message") break;
      if (leaf.message.role === "user" && msgStr(leaf.message).trim() === anchor) {
        break;
      }
      const parentId = leaf.parentId;
      state.entries = state.entries.filter((e) => e.id !== leaf.id);
      state.byId.delete(leaf.id);
      state.leafId = parentId;
      changed = true;
    }
    if (!changed) return false;
    state.hasAssistant = state.entries.some(
      (e) => e.type === "message" && e.message.role === "assistant",
    );
    await rewriteSessionFile(state, this.baseDir);
    state.flushed = true;
    return true;
  }

  /**
   * 追加 compaction 记录
   */
  async appendCompaction(
    sessionKey: string,
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<void> {
    const state = await this.ensureState(sessionKey);
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateId(state.byId),
      parentId: state.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    const prevLeafId = state.leafId;
    const prevHasAssistant = state.hasAssistant;
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.leafId = entry.id;
    try {
      await this.persistEntry(state, entry);
    } catch (err) {
      state.entries.pop();
      state.byId.delete(entry.id);
      state.leafId = prevLeafId;
      state.hasAssistant = prevHasAssistant;
      throw err;
    }
  }

  /**
   * 根据 Message 找到对应的 entryId
   * - 先走引用映射
   * - 再按 timestamp + role 兜底
   */
  resolveMessageEntryId(sessionKey: string, message: Message): string | undefined {
    if (typeof message.content === "string") {
      const trimmed = message.content.trimStart();
      if (trimmed.startsWith(COMPACTION_SUMMARY_PREFIX)) {
        return undefined;
      }
    }
    const state = this.states.get(sessionKey);
    if (!state) {
      return undefined;
    }
    const direct = state.messageIdByRef.get(message);
    if (direct) {
      return direct;
    }
    for (const entry of state.entries) {
      if (entry.type !== "message") continue;
      if (entry.message.timestamp === message.timestamp && entry.message.role === message.role) {
        return entry.id;
      }
    }
    return undefined;
  }

  /**
   * 获取会话消息 (仅内存)
   * 用于快速读取，不触发磁盘 IO
   */
  get(sessionKey: string): Message[] {
    const state = this.states.get(sessionKey);
    if (!state) {
      return [];
    }
    return buildSessionContext(state);
  }

  /**
   * 清空会话
   * 同时清理内存缓存和磁盘文件
   */
  async clear(sessionKey: string): Promise<void> {
    // Remove from cache first to reject new appends
    const state = this.states.get(sessionKey);
    this.states.delete(sessionKey);
    this.sessionLastAccess.delete(sessionKey);
    this.sessionApproxBytes.delete(sessionKey);

    // Acquire the write lock to prevent racing with in-flight append()
    const filePath = this.getPath(sessionKey);
    if (state) {
      const lock = await acquireSessionWriteLock({ sessionFile: filePath });
      try {
        await fs.unlink(filePath).catch(() => {});
        const legacyPath = this.getLegacyPath(sessionKey);
        if (legacyPath !== filePath) await fs.unlink(legacyPath).catch(() => {});
      } finally {
        await lock.release();
      }
    } else {
      try {
        await fs.unlink(filePath);
      } catch {
        // file doesn't exist
      }
      try {
        const legacyPath = this.getLegacyPath(sessionKey);
        if (legacyPath !== filePath) await fs.unlink(legacyPath);
      } catch {
        // legacy file doesn't exist
      }
    }
  }

  /**
   * 列出所有会话
   * 扫描目录下的 .jsonl 文件
   */
  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      return files
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => {
          try {
            return decodeURIComponent(f.replace(".jsonl", ""));
          } catch {
            return f.replace(".jsonl", "");
          }
        });
    } catch {
      return [];
    }
  }

  private async ensureState(sessionKey: string): Promise<SessionState> {
    const cached = this.states.get(sessionKey);
    if (cached) {
      this.touchSessionKey(sessionKey, cached);
      return cached;
    }

    // Deduplicate concurrent loads for the same session key
    const inflight = this.loadingPromises.get(sessionKey);
    if (inflight) return inflight;

    const loadPromise = this.loadAndCacheState(sessionKey);
    this.loadingPromises.set(sessionKey, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.loadingPromises.delete(sessionKey);
    }
  }

  private async loadAndCacheState(sessionKey: string): Promise<SessionState> {
    const filePath = this.getPath(sessionKey);
    const legacyPath = this.getLegacyPath(sessionKey);
    let chosenPath = filePath;
    let state: SessionState | undefined;

    try {
      const loaded = await loadSessionFile(filePath);
      if (loaded.header) {
        state = buildStateFromEntries(filePath, loaded.header, loaded.entries);
      } else if (loaded.legacyMessages) {
        state = buildStateFromLegacy(filePath, loaded.legacyMessages);
        if (state.hasAssistant || state.entries.length > 0) {
          await rewriteSessionFile(state, this.baseDir);
          state.flushed = true;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (!state) {
      try {
        const loaded = await loadSessionFile(legacyPath);
        if (loaded.header) {
          chosenPath = legacyPath;
          state = buildStateFromEntries(legacyPath, loaded.header, loaded.entries);
        } else if (loaded.legacyMessages) {
          chosenPath = legacyPath;
          state = buildStateFromLegacy(legacyPath, loaded.legacyMessages);
          if (state.hasAssistant || state.entries.length > 0) {
            await rewriteSessionFile(state, this.baseDir);
            state.flushed = true;
          }
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    if (!state) {
      const header = this.createHeader();
      state = {
        filePath: chosenPath,
        header,
        entries: [],
        byId: new Map<string, SessionEntry>(),
        messageIdByRef: new WeakMap<Message, string>(),
        leafId: null,
        flushed: false,
        hasAssistant: false,
      };
    }

    this.states.set(sessionKey, state);
    this.touchSessionKey(sessionKey, state);
    await this.evictSessionCacheIfNeeded();
    return state;
  }

  private async persistEntry(state: SessionState, entry: SessionEntry): Promise<void> {
    /** 至少有一条用户消息也应落盘，便于导出排查包在「首轮未完成」时仍能拿到 JSONL（旧逻辑仅在有助手回复后才写盘）。 */
    const hasUserMessage = state.entries.some(
      (e) => e.type === "message" && e.message.role === "user",
    );
    if (!state.hasAssistant && !hasUserMessage) {
      return;
    }
    const lock = await acquireSessionWriteLock({ sessionFile: state.filePath });
    try {
      if (!state.flushed) {
        await rewriteSessionFile(state, this.baseDir, { skipLock: true });
        state.flushed = true;
        return;
      }
      await fs.mkdir(this.baseDir, { recursive: true });
      const fh = await fs.open(state.filePath, "a");
      try {
        await fh.write(`${formatJsonlLine(entry)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } finally {
      await lock.release();
    }
  }

}

type SessionState = {
  filePath: string;
  header: SessionHeaderEntry;
  entries: SessionEntry[];
  byId: Map<string, SessionEntry>;
  messageIdByRef: WeakMap<Message, string>;
  leafId: string | null;
  flushed: boolean;
  hasAssistant: boolean;
};

function generateId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return crypto.randomUUID();
}

function buildSessionContext(state: SessionState): Message[] {
  if (state.entries.length === 0) {
    return [];
  }

  if (state.leafId === null) {
    return [];
  }

  const leaf = state.leafId ? state.byId.get(state.leafId) : state.entries[state.entries.length - 1];
  if (!leaf) {
    return [];
  }

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? state.byId.get(current.parentId) : undefined;
  }
  path.reverse();

  let compaction: CompactionEntry | null = null;
  for (const entry of path) {
    if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: Message[] = [];
  const appendMessage = (entry: SessionEntry) => {
    if (entry.type === "message") {
      messages.push(entry.message);
    }
  };

  if (compaction) {
    messages.push(createCompactionSummaryMessage(compaction.summary, compaction.timestamp));
    const compactionIdx = path.findIndex(
      (entry) => entry.type === "compaction" && entry.id === compaction.id,
    );
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry);
      }
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      appendMessage(path[i]);
    }
  } else {
    for (const entry of path) {
      appendMessage(entry);
    }
  }

  return messages;
}

function buildStateFromEntries(
  filePath: string,
  header: SessionHeaderEntry,
  entries: SessionEntry[],
): SessionState {
  const byId = new Map<string, SessionEntry>();
  const messageIdByRef = new WeakMap<Message, string>();
  let leafId: string | null = null;
  let hasAssistant = false;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    leafId = entry.id;
    if (entry.type === "message") {
      messageIdByRef.set(entry.message, entry.id);
      if (entry.message.role === "assistant") {
        hasAssistant = true;
      }
    }
  }

  return {
    filePath,
    header,
    entries,
    byId,
    messageIdByRef,
    leafId,
    flushed: true,
    hasAssistant,
  };
}

function buildStateFromLegacy(filePath: string, messages: Message[]): SessionState {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  } satisfies SessionHeaderEntry;
  const entries: SessionEntry[] = [];
  const byId = new Map<string, SessionEntry>();
  const messageIdByRef = new WeakMap<Message, string>();
  let leafId: string | null = null;
  let hasAssistant = false;

  for (const message of messages) {
    const entry: MessageEntry = {
      type: "message",
      id: generateId(byId),
      parentId: leafId,
      timestamp: new Date().toISOString(),
      message: {
        role: message.role,
        content: message.content,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        ...(message.thinking && message.thinking.length > 0 ? { thinking: [...message.thinking] } : {}),
      },
    };
    entries.push(entry);
    byId.set(entry.id, entry);
    messageIdByRef.set(entry.message, entry.id);
    leafId = entry.id;
    if (entry.message.role === "assistant") {
      hasAssistant = true;
    }
  }

  return {
    filePath,
    header,
    entries,
    byId,
    messageIdByRef,
    leafId,
    flushed: false,
    hasAssistant,
  };
}

async function rewriteSessionFile(
  state: SessionState,
  baseDir: string,
  opts?: { skipLock?: boolean },
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });

  const allEntries = [state.header, ...state.entries];
  let lines = allEntries.map((entry) => formatJsonlLine(entry));
  let content = `${lines.join("\n")}\n`;

  // File rotation: if content exceeds MAX_SESSION_FILE_BYTES, keep header +
  // only the most recent entries that fit within the limit.
  if (Buffer.byteLength(content, "utf-8") > MAX_SESSION_FILE_BYTES && allEntries.length > 1) {
    const headerLine = lines[0];
    const headerSize = Buffer.byteLength(headerLine, "utf-8") + 1; // +1 for trailing \n
    let used = headerSize;
    const kept: string[] = [];
    // Walk backwards from the most recent entry
    for (let i = lines.length - 1; i >= 1; i--) {
      const lineSize = Buffer.byteLength(lines[i], "utf-8") + 1; // +1 for \n
      if (used + lineSize > MAX_SESSION_FILE_BYTES) break;
      kept.unshift(lines[i]);
      used += lineSize;
    }
    lines = [headerLine, ...kept];
    content = `${lines.join("\n")}\n`;

    // Final validation: ensure rotated content fits within the size cap
    while (Buffer.byteLength(content, "utf-8") > MAX_SESSION_FILE_BYTES && kept.length > 0) {
      kept.shift();
      lines = [headerLine, ...kept];
      content = `${lines.join("\n")}\n`;
    }

    // Archive the oversized file (best-effort; ignore if it doesn't exist yet)
    try {
      await fs.rename(state.filePath, `${state.filePath}.1`);
    } catch {
      // archive rotation: file may not exist on first flush — safe to ignore
    }
  }

  if (opts?.skipLock) {
    await atomicWriteFile(state.filePath, content);
    return;
  }
  const lock = await acquireSessionWriteLock({ sessionFile: state.filePath });
  try {
    await atomicWriteFile(state.filePath, content);
  } finally {
    await lock.release();
  }
}
