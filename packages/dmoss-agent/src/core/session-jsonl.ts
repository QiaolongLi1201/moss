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

// ============== 会话管理器 ==============

export class SessionManager {
  /** 会话文件存储目录 */
  private baseDir: string;

  /** Session 缓存（避免重复加载/解析） */
  private states = new Map<string, SessionState>();

  /** 内存中最多保留的热会话数，防止 unique sessionKey 无限增长导致 OOM */
  private static readonly MAX_CACHED_SESSIONS = 100;
  private sessionLastAccess = new Map<string, number>();

  constructor(baseDir: string = "./.dmoss/sessions") {
    this.baseDir = baseDir;
  }

  private touchSessionKey(sessionKey: string) {
    this.sessionLastAccess.set(sessionKey, Date.now());
  }

  private evictSessionCacheIfNeeded() {
    const max = SessionManager.MAX_CACHED_SESSIONS;
    if (this.states.size <= max) return;
    const byAccess = [...this.sessionLastAccess.entries()].sort((a, b) => a[1] - b[1]);
    let over = this.states.size - max;
    for (const [key] of byAccess) {
      if (over <= 0) break;
      if (this.states.delete(key)) {
        this.sessionLastAccess.delete(key);
        over--;
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
   * 为什么用 appendFile 而不是 writeFile？
   * - appendFile 是追加写入，不需要读取整个文件
   * - 写入是 O(1)，无论文件多大
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
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.messageIdByRef.set(message, entry.id);
    state.leafId = entry.id;
    if (message.role === "assistant") {
      state.hasAssistant = true;
    }
    await this.persistEntry(state, entry);
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
    state.entries.push(entry);
    state.byId.set(entry.id, entry);
    state.leafId = entry.id;
    await this.persistEntry(state, entry);
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
    this.states.delete(sessionKey);
    const filePath = this.getPath(sessionKey);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在，忽略
    }
    try {
      const legacyPath = this.getLegacyPath(sessionKey);
      if (legacyPath !== filePath) {
        await fs.unlink(legacyPath);
      }
    } catch {
      // 旧文件不存在，忽略
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
      return cached;
    }

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
    } catch {
      // ignore
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
      } catch {
        // ignore
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
    this.touchSessionKey(sessionKey);
    this.evictSessionCacheIfNeeded();
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
      await fs.appendFile(state.filePath, `${JSON.stringify(entry)}\n`);
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

function isSessionHeader(value: unknown): value is SessionHeaderEntry {
  if (!value || typeof value !== "object") return false;
  const header = value as SessionHeaderEntry;
  return header.type === "session" && typeof header.id === "string";
}

function isLegacyMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const msg = value as Message;
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  if (!("content" in msg)) return false;
  return typeof msg.timestamp === "number";
}

function parseJsonlLines(content: string): unknown[] {
  const entries: unknown[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 跳过损坏行，尽量保留其他记录
    }
  }
  return entries;
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
    path.unshift(current);
    current = current.parentId ? state.byId.get(current.parentId) : undefined;
  }

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

async function loadSessionFile(
  filePath: string,
): Promise<{ header?: SessionHeaderEntry; entries: SessionEntry[]; legacyMessages?: Message[] }> {
  const content = await fs.readFile(filePath, "utf-8");
  const rawEntries = parseJsonlLines(content);

  if (rawEntries.length === 0) {
    return { entries: [] };
  }

  const [first, ...rest] = rawEntries;
  if (!isSessionHeader(first)) {
    const messages = rawEntries.filter(isLegacyMessage);
    return { entries: [], legacyMessages: messages };
  }

  const header: SessionHeaderEntry = {
    ...first,
    version: typeof first.version === "number" ? first.version : CURRENT_SESSION_VERSION,
  };
  const entries: SessionEntry[] = [];

  for (const entry of rest) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as SessionEntry;
    if (!typed.type || typeof typed.id !== "string") continue;
    if (typed.type === "message" && (typed as MessageEntry).message) {
      entries.push(typed);
      continue;
    }
    if (
      typed.type === "compaction" &&
      typeof (typed as CompactionEntry).summary === "string" &&
      typeof (typed as CompactionEntry).firstKeptEntryId === "string"
    ) {
      entries.push(typed);
    }
  }

  return { header, entries };
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
  const lines = [state.header, ...state.entries].map((entry) => JSON.stringify(entry));
  const content = `${lines.join("\n")}\n`;
  if (opts?.skipLock) {
    await fs.writeFile(state.filePath, content);
    return;
  }
  const lock = await acquireSessionWriteLock({ sessionFile: state.filePath });
  try {
    await fs.writeFile(state.filePath, content);
  } finally {
    await lock.release();
  }
}
