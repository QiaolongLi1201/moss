/**
 * Long-term memory system — keyword-based search over stored text entries.
 *
 * Storage: filesystem JSON index
 * Search: BM25-style keyword scoring (term frequency + document length normalization)
 * Deduplication: content hash-based
 *
 * Memory consolidation cues (bounded, cautious):
 * - Multi-query recall: merge scores across short cross-language anchor passes so EN questions
 *   can surface CN-stored facts (and vice versa) without embeddings.
 * - Soft index size hint: callers can warn when the corpus grows past MEMORY_INDEX_CHAR_SOFT_LIMIT.
 * - validateMemoryWriteContent: block a small set of obvious prompt-injection / script patterns.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MemoryEmbeddingProvider, EmbeddedMemoryEntry } from './memory-embedding.js';
import { cosineSimilarity, hybridScore } from './memory-embedding.js';

/** Soft cap for total indexed characters — not enforced; used for consolidation hints. */
export const MEMORY_INDEX_CHAR_SOFT_LIMIT = 50_000;

const CN_RECALL_ANCHOR = '用户偏好 回答方式 结论 步骤 简洁 详细';
const EN_RECALL_ANCHOR = 'preference response style conclusion steps detail';
const CN_DEVICE_PROJECT_ANCHOR = '设备 板卡 型号 工作区 项目 约束 开发板 IP 地址 hostname';
const EN_DEVICE_PROJECT_ANCHOR = 'device board model workspace project constraint devkit ip hostname';

export type MemorySource = 'memory' | 'sessions';

export type MemoryWriteValidation =
  | { ok: true }
  | { ok: false; reason: string };

const MEMORY_INJECTION_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts?|rules?)/i,
    reason: '疑似提示注入（ignore previous instructions）',
  },
  {
    re: /disregard\s+(the\s+)?(above|prior)/i,
    reason: '疑似提示注入（disregard prior）',
  },
  { re: /<\s*script\b/i, reason: '不允许脚本标签' },
  { re: /\bnew\s+system\s+prompt\b/i, reason: '疑似伪造系统提示' },
];

/**
 * Conservative gate before persisting memory — narrow rule set, high precision over recall.
 */
export function validateMemoryWriteContent(content: string): MemoryWriteValidation {
  const text = content.trim();
  if (!text) return { ok: false, reason: '内容为空' };
  for (const { re, reason } of MEMORY_INJECTION_PATTERNS) {
    if (re.test(text)) return { ok: false, reason };
  }
  return { ok: true };
}

function looksLikeRecallOrPreferenceQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (/[\u4e00-\u9fff]/.test(q)) {
    return /偏好|习惯|回答|方式|风格|记忆|记住|之前|上次|甚么|什么|如何|怎样/.test(q);
  }
  const lower = q.toLowerCase();
  return /\b(prefer|preference|preferences|response\s*style|how\s+do\s+i\s+like|what\s+.*\s+(prefer|like)|remember|recall|habit|conclusion|steps?|earlier|before|last\s+time)\b/i.test(
    lower,
  );
}

/** Stable device / workspace / project facts — cross-language anchors like preference recall. */
function looksLikeDeviceOrProjectRecallQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (/[\u4e00-\u9fff]/.test(q)) {
    return /设备|板子|板卡|开发板|型号|工作区|项目|约束|网段|地址|hostname|上次|之前|记过|还记得|提到过/.test(q);
  }
  const lower = q.toLowerCase();
  return /\b(device|board|dev\s*board|rdk|workspace|project|constraint|hostname|ip\s+address|what\s+.*\s+(model|board)|which\s+board|last\s+time|earlier|remember\s+what)\b/i.test(
    lower,
  );
}

/**
 * Variants merged by {@link MemoryManager.search}: primary user text plus short anchors so
 * cross-language stored entries remain discoverable.
 */
export function buildMemorySearchQueryVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants: string[] = [];
  if (trimmed) variants.push(trimmed);
  if (looksLikeRecallOrPreferenceQuery(trimmed)) {
    variants.push(CN_RECALL_ANCHOR);
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      variants.push(EN_RECALL_ANCHOR);
    }
  }
  if (looksLikeDeviceOrProjectRecallQuery(trimmed)) {
    variants.push(CN_DEVICE_PROJECT_ANCHOR);
    if (/[\u4e00-\u9fff]/.test(trimmed)) {
      variants.push(EN_DEVICE_PROJECT_ANCHOR);
    }
  }
  return [...new Set(variants.map((s) => s.trim()).filter(Boolean))];
}

/**
 * MemoryScope 四档分层，`workspace` 默认：
 * - `workspace` 绑当前 Studio workspace（由 Studio 侧 projectHash 提供，本地落盘为 scopeRef）
 * - `user` 跨 workspace 共享
 * - `device` 仅在当前选定 deviceId 下注入；`scopeRef` 存 deviceId
 * - `learning` 个人学习沉淀库（不进 system-prompt 默认注入；与 workspace/user/device 并列存储）
 * 旧条目无字段时按 `workspace` 兜底（读时填充，不污染磁盘）。
 */
export type MemoryScope = 'workspace' | 'user' | 'device' | 'learning';

/** Learning tab topic slugs (PATCH / UI whitelist). Order matches `aidock.memory.learning.topicLabels` lines in Studio i18n. */
export const LEARNING_TOPIC_SLUGS = [
  'usb',
  'ros',
  'hbm',
  'deploy',
  'network',
  'vision',
  'general',
  'other',
] as const;

export type LearningTopicSlug = (typeof LEARNING_TOPIC_SLUGS)[number];

export interface MemoryEntry {
  id: string;
  content: string;
  source: MemorySource;
  path?: string;
  hash: string;
  createdAt: number;
  /** 记忆可见性档位；旧条目（undefined）视为 `workspace`。 */
  scope?: MemoryScope;
  /** scope=device 时存 deviceId；scope=workspace 时可存 projectHash；scope=user 时 undefined。 */
  scopeRef?: string;
  /** pin 置顶 + 检索小幅加权（~15%）；旧条目（undefined）视为 `false`。 */
  pinned?: boolean;
  /** 学习库主题 slug（如 usb/ros/…）；旧条目缺失时视为 undefined。 */
  topic?: string;
  /** 学习库标星；旧条目（undefined）语义等同未标星 / false，仅 `true` 为标星。 */
  starred?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

function computeKeywordScore(content: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const text = content.toLowerCase();
  const normalizedLength = Math.max(text.length, 1);

  let matchedTerms = 0;
  let totalTf = 0;

  for (const term of queryTerms) {
    let tf = 0;
    let pos = 0;
    while (true) {
      const idx = text.indexOf(term, pos);
      if (idx === -1) break;
      tf += 1;
      pos = idx + term.length;
    }

    if (tf > 0) {
      matchedTerms += 1;
      const k1 = 1.2;
      const saturatedTf = tf / (tf + k1);
      totalTf += saturatedTf;
    }
  }

  if (matchedTerms === 0) return 0;

  const coverage = matchedTerms / queryTerms.length;
  const avgDocLength = 500;
  const b = 0.75;
  const lengthPenalty = 1 - b + b * (normalizedLength / avgDocLength);

  return (coverage * totalTf) / lengthPenalty;
}

function extractQueryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [];
  return [...new Set(tokens)];
}

function rankEntriesByTerms(entries: MemoryEntry[], queryTerms: string[]): MemorySearchResult[] {
  if (queryTerms.length === 0) return [];
  const scored: MemorySearchResult[] = [];
  for (const entry of entries) {
    const score = computeKeywordScore(entry.content, queryTerms);
    if (score > 0) {
      scored.push({ entry, score, snippet: entry.content.slice(0, 200) });
    }
  }
  return scored.sort((a, b) => b.score - a.score);
}

export class MemoryManager {
  private baseDir: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;
  private _writeChain: Promise<void> = Promise.resolve();
  private embeddingMap = new Map<string, number[]>();

  constructor(baseDir: string = './.dmoss/memory', private embeddingProvider?: MemoryEmbeddingProvider) {
    this.baseDir = baseDir;
  }

  private get indexPath(): string {
    return path.join(this.baseDir, 'index.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(content);
      // M6: Validate parsed JSON is an array
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.entries = [];
    }
    try {
      const raw = await fs.readFile(path.join(this.baseDir, 'embeddings.json'), 'utf-8');
      const arr: EmbeddedMemoryEntry[] = JSON.parse(raw);
      this.embeddingMap = new Map(arr.map(e => [e.id, e.embedding]));
    } catch {
      this.embeddingMap = new Map();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    // M3: Atomic write — write to temp file then rename
    const tmpPath = this.indexPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(this.entries, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.indexPath);
  }

  private async saveEmbeddings(): Promise<void> {
    if (!this.embeddingProvider) return;
    await fs.mkdir(this.baseDir, { recursive: true });
    const embedPath = path.join(this.baseDir, 'embeddings.json');
    const tmp = embedPath + '.tmp';
    const arr = Array.from(this.embeddingMap.entries()).map(([id, embedding]) => ({ id, embedding }));
    await fs.writeFile(tmp, JSON.stringify(arr), 'utf-8');
    await fs.rename(tmp, embedPath);
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  async add(
    content: string,
    source: MemorySource = 'memory',
    filePath?: string,
    options?: { scope?: MemoryScope; scopeRef?: string; pinned?: boolean; topic?: string; starred?: boolean },
  ): Promise<string> {
    // H3: Serialize writes through a promise chain to prevent race conditions
    const result = this._writeChain.then(async () => {
      await this.load();

      const hash = this.hashContent(content);
      const id = `mem_${hash}`;

      const existingIndex = this.entries.findIndex((e) => e.hash === hash);
      if (existingIndex >= 0) {
        this.entries[existingIndex].content = content;
        this.entries[existingIndex].path = filePath;
        if (options?.scope !== undefined) this.entries[existingIndex].scope = options.scope;
        if (options?.scopeRef !== undefined) this.entries[existingIndex].scopeRef = options.scopeRef;
        if (options?.pinned !== undefined) this.entries[existingIndex].pinned = options.pinned;
        if (options?.topic !== undefined) {
          if (options.topic === '') delete this.entries[existingIndex].topic;
          else this.entries[existingIndex].topic = options.topic;
        }
        if (options?.starred !== undefined) {
          if (!options.starred) delete this.entries[existingIndex].starred;
          else this.entries[existingIndex].starred = true;
        }
        await this.save();
        return this.entries[existingIndex].id;
      }

      const entry: MemoryEntry = {
        id,
        content,
        source,
        path: filePath,
        hash,
        createdAt: Date.now(),
        ...(options?.scope !== undefined ? { scope: options.scope } : {}),
        ...(options?.scopeRef !== undefined ? { scopeRef: options.scopeRef } : {}),
        ...(options?.pinned !== undefined ? { pinned: options.pinned } : {}),
        ...(options?.topic !== undefined && options.topic !== ''
          ? { topic: options.topic }
          : {}),
        ...(options?.starred !== undefined && options.starred ? { starred: true } : {}),
      };
      this.entries.push(entry);
      await this.save();
      if (this.embeddingProvider) {
        try {
          const [vec] = await this.embeddingProvider.embed([content]);
          this.embeddingMap.set(entry.id, vec);
        } catch {
        }
        await this.saveEmbeddings();
      }
      return id;
    }).catch(err => {
      console.warn('[memory] write chain error:', err);
      return '';
    });
    this._writeChain = result.then(() => {});
    return result;
  }

  /**
   * 局部更新 entry 的 content/scope/scopeRef/pinned/topic/starred；禁止改 id/hash/createdAt/source/path。
   * 返回 true 表示命中并更新；false 表示 id 不存在。
   */
  async update(
    id: string,
    patch: Partial<
      Pick<MemoryEntry, 'content' | 'scope' | 'scopeRef' | 'pinned' | 'topic' | 'starred'>
    >,
  ): Promise<boolean> {
    // H3: Serialize writes through the promise chain
    const result = this._writeChain.then(async () => {
      await this.load();
      const idx = this.entries.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      const entry = this.entries[idx];
      if (patch.content !== undefined && typeof patch.content === 'string') {
        entry.content = patch.content;
        entry.hash = this.hashContent(patch.content);
      }
      if (patch.scope !== undefined) entry.scope = patch.scope;
      if (patch.scopeRef !== undefined) entry.scopeRef = patch.scopeRef;
      if (patch.pinned !== undefined) entry.pinned = patch.pinned;
      if (patch.topic !== undefined) {
        if (patch.topic === '') delete entry.topic;
        else entry.topic = patch.topic;
      }
      if (patch.starred !== undefined) {
        if (!patch.starred) delete entry.starred;
        else entry.starred = true;
      }
      await this.save();
      if (patch.content && this.embeddingProvider) {
        this.embeddingMap.delete(id);
        try {
          const [vec] = await this.embeddingProvider.embed([patch.content]);
          this.embeddingMap.set(id, vec);
        } catch {
        }
        await this.saveEmbeddings();
      }
      return true;
    }).catch(err => {
      console.warn('[memory] write chain error:', err);
      return false;
    });
    this._writeChain = result.then(() => {});
    return result;
  }

  /** pin / unpin 的快捷入口；返回 true = 命中并写入；false = id 不存在。 */
  async togglePinned(id: string, pinned: boolean): Promise<boolean> {
    return this.update(id, { pinned });
  }

  /** 按 scope + 可选 scopeRef 精确过滤；pinned 排前，createdAt 倒序次之。 */
  async listByScope(scope: MemoryScope, scopeRef?: string): Promise<MemoryEntry[]> {
    await this.load();
    const normalized = this.entries.filter((e) => {
      const effScope: MemoryScope = e.scope ?? 'workspace';
      if (effScope !== scope) return false;
      if (scopeRef !== undefined) {
        if ((e.scopeRef ?? undefined) !== scopeRef) return false;
      }
      return true;
    });
    return normalized.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  }

  async search(
    query: string,
    limit = 5,
    options?: { scope?: MemoryScope | MemoryScope[]; scopeRef?: string },
  ): Promise<MemorySearchResult[]> {
    await this.load();

    const variants = buildMemorySearchQueryVariants(query);
    const bestById = new Map<string, MemorySearchResult>();

    const allowedScopes = options?.scope
      ? (Array.isArray(options.scope) ? options.scope : [options.scope])
      : null;
    const filteredEntries = allowedScopes
      ? this.entries.filter((e) => {
          const effScope: MemoryScope = e.scope ?? 'workspace';
          if (!allowedScopes.includes(effScope)) return false;
          if (options?.scopeRef !== undefined) {
            if ((e.scopeRef ?? undefined) !== options.scopeRef) return false;
          }
          return true;
        })
      : this.entries;

    for (const variant of variants) {
      const queryTerms = extractQueryTerms(variant);
      const ranked = rankEntriesByTerms(filteredEntries, queryTerms);
      for (const r of ranked) {
        const prev = bestById.get(r.entry.id);
        if (!prev || r.score > prev.score) {
          bestById.set(r.entry.id, r);
        }
      }
    }

    /** pinned 条目给 1.15× 小幅加权（R-3 决策：仅 UI 排序 + 轻加权，不破坏 BM25 排序语义）。 */
    const boosted: MemorySearchResult[] = [...bestById.values()].map((r) =>
      r.entry.pinned ? { ...r, score: r.score * 1.15 } : r,
    );

    if (this.embeddingProvider && this.embeddingMap.size > 0) {
      try {
        const [queryVec] = await this.embeddingProvider.embed([query]);
        for (const result of boosted) {
          const embedding = this.embeddingMap.get(result.entry.id);
          if (embedding) {
            const semanticScore = cosineSimilarity(queryVec, embedding);
            result.score = hybridScore(result.score, semanticScore);
          }
        }
        boosted.sort((a, b) => b.score - a.score);
      } catch {
      }
    }

    return boosted.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Sum of stored entry lengths — for soft-limit / consolidation hints. */
  async getApproxIndexCharCount(): Promise<number> {
    await this.load();
    return this.entries.reduce((n, e) => n + e.content.length, 0);
  }

  async getById(id: string): Promise<MemoryEntry | null> {
    await this.load();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  async syncFromFiles(): Promise<number> {
    await this.load();
    const memDir = path.join(this.baseDir, 'files');

    try {
      const files = await fs.readdir(memDir);
      let synced = 0;

      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(memDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const hash = this.hashContent(content);

        const existing = this.entries.find((e) => e.path === filePath);
        if (existing && existing.hash === hash) continue;

        await this.add(content, 'memory', filePath);
        synced++;
      }

      return synced;
    } catch {
      return 0;
    }
  }

  async delete(id: string): Promise<boolean> {
    // H3: Serialize writes through the promise chain
    const result = this._writeChain.then(async () => {
      await this.load();
      const idx = this.entries.findIndex((e) => e.id === id);
      if (idx === -1) return false;
      this.entries.splice(idx, 1);
      this.embeddingMap.delete(id);
      await this.save();
      await this.saveEmbeddings();
      return true;
    }).catch(err => {
      console.warn('[memory] write chain error:', err);
      return false;
    });
    this._writeChain = result.then(() => {});
    return result;
  }

  async getAll(): Promise<MemoryEntry[]> {
    await this.load();
    return this.entries;
  }

  async clear(): Promise<void> {
    // H3: Serialize writes through the promise chain
    const result = this._writeChain.then(async () => {
      this.entries = [];
      this.embeddingMap.clear();
      await this.save();
      await this.saveEmbeddings();
    }).catch(err => {
      console.warn('[memory] write chain error:', err);
    });
    this._writeChain = result;
    return result;
  }
}
