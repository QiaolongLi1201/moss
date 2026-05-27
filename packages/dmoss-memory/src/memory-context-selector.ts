/**
 * memory-context-selector — chat-memory-surface 2026-04-24
 *
 * 负责从当前 workspace 的 MemoryManager 按 scope 分层拉取「少量、相关度高」的条目，
 * 供 system prompt 注入（避免 prompt 膨胀，保留 BM25 排序的命中）。
 *
 * 使用时机（设计阶段预留，未在本轮 streamChat 链路落地；见 dev.log followup）：
 *   在 DmossApp.streamChat 的 system-prompt 构建阶段，按 `{ deviceId, projectHash, lastUserMessage }`
 *   调用本函数，返回 `selected[]` 注入到已有 `memory_hint` 段之前（或用 `memoryPreloadLayer`）。
 *
 * 测试（DoD-5 验收）: packages/dmoss-agent 本体 E2E + server 侧单测均可独立断言；本函数纯函数可组合。
 */
import type { MemoryEntry, MemoryManager, MemoryScope } from './memory-manager.js';

export interface SelectMemoryForContextParams {
  memoryManager: MemoryManager;
  deviceId?: string;
  projectHash?: string;
  query: string;
  /** device-scope top, default 2 */
  deviceTopN?: number;
  /** workspace-scope top, default 1 */
  workspaceTopN?: number;
  /** user-scope top, default 1 */
  userTopN?: number;
  /**
   * global hard cap, default 3.
   * 历史默认是 6，会把多个 scope 的旧条目同时塞进 system prompt；3 条更聚焦当前任务，
   * 远端再贵的模型也不会被无关旧记忆带偏。需要更多上下文时由调用方显式传值。
   */
  maxTotal?: number;
  /**
   * 相关性分数下限。BM25 `score = coverage * totalTf / lengthPenalty`，强命中 ~1.0+、
   * 弱命中 ~0.1–0.3。默认 0.3：低于此值的命中**不**注入。设 0 关闭门槛（恢复旧行为）。
   */
  minScore?: number;
}

export interface MemoryContextPick {
  entry: MemoryEntry;
  score: number;
  snippet: string;
  /** effective scope after fallback (old entries without `scope` are treated as 'workspace') */
  scope: MemoryScope;
}

/**
 * 分档取 memory:
 * - device scope (匹配 deviceId): 3 条
 * - workspace scope (匹配 projectHash，若未传则全 workspace): 2 条
 * - user scope: 1 条
 *
 * 若某一档无命中，不会自动向其它档补足（避免越权扩展）。
 * 同一条目若被多档同时命中，以 device > workspace > user 优先级去重。
 */
export async function selectMemoriesForContext(
  params: SelectMemoryForContextParams,
): Promise<MemoryContextPick[]> {
  const {
    memoryManager,
    deviceId,
    projectHash,
    query,
    deviceTopN = 2,
    workspaceTopN = 1,
    userTopN = 1,
    maxTotal = 3,
    minScore = 0.3,
  } = params;

  const picks: MemoryContextPick[] = [];
  const seenIds = new Set<string>();
  const passesScore = (score: number): boolean => minScore <= 0 || score >= minScore;

  if (deviceId) {
    const ranked = await memoryManager.search(query, deviceTopN, {
      scope: 'device',
      scopeRef: deviceId,
    });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'device' });
      if (picks.length >= maxTotal) break;
    }
  }

  if (picks.length < maxTotal) {
    const ranked = await memoryManager.search(query, workspaceTopN, {
      scope: 'workspace',
      scopeRef: projectHash,
    });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'workspace' });
      if (picks.length >= maxTotal) break;
    }
  }

  if (picks.length < maxTotal) {
    const ranked = await memoryManager.search(query, userTopN, { scope: 'user' });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'user' });
      if (picks.length >= maxTotal) break;
    }
  }

  return picks;
}

/**
 * 把 picks 渲染成供 system prompt 注入的多行文本段；caller 决定是否 sanitize / 是否节流字符数。
 *
 * 输出示例:
 * ```
 * ## 已有记忆（按 scope 优先级注入）
 *
 * [device · #mem_xxxx] 用户偏好中文简洁回答...
 * [workspace · #mem_yyyy] 当前项目使用 RDK X5 + OpenClaw...
 * [user · #mem_zzzz] 用户偏好先列 bullets...
 * ```
 *
 * - 每条 ≤ 200 char（通过 entry.content.slice 已在 MemoryManager.search 里完成）。
 * - 省略 entry.hash / createdAt 等元字段，避免污染 prompt。
 */
export function renderMemoryPicksForSystemPrompt(
  picks: MemoryContextPick[],
  sanitizeFn?: (text: string) => string,
): string {
  if (picks.length === 0) return '';
  const lines: string[] = ['## 已有记忆（按 scope 优先级注入）', ''];
  for (const p of picks) {
    const raw = p.snippet ?? p.entry.content.slice(0, 200);
    const content = sanitizeFn ? sanitizeFn(raw) : raw;
    lines.push(`[${p.scope} · #${p.entry.id}] ${content}`);
  }
  return lines.join('\n');
}
