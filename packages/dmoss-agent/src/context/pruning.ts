/**
 * 上下文修剪 (Context Pruning)
 *
 * 三层递进修剪策略:
 *
 * Layer 1: Soft Trim (工具结果内容截断)
 *   触发: 比例超过 softTrimRatio (默认 0.3)
 *   操作: 对可修剪工具的结果保留 head + tail，丢弃中间
 *
 * Layer 2: Hard Clear (工具结果内容清空)
 *   触发: soft trim 后比例仍超过 hardClearRatio (默认 0.5)
 *   前提: 可修剪工具结果总字符数 > minPrunableToolChars
 *   操作: 用占位符替换工具结果内容 "[Old tool result content cleared]"
 *
 * Layer 3: Message Drop (消息级丢弃)
 *   触发: 总字符超过 history budget
 *   操作: 从旧到新丢弃整条消息，保护最近 N 条 assistant
 */

import {
  COMPACTION_SUMMARY_PREFIX,
  type ContentBlock,
  type Message,
} from "../core/session-jsonl.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateMessagesChars,
} from "./tokens.js";

/**
 * Messages 在历史预算计算中至少预留的 token 档位（在与 `charsPerUnit` 相乘得到 char 窗口前）。
 *
 * 背景：thinking / 超长 system 命中 `rawTotalChars / effectiveContextTokens >= 0.85`
 * 时，agent-loop 会把 `charsPerTokenUnit` 收紧到 **1**（字符≈token 最坏估计）。
 * 若此时 `systemPromptTokens` **高估**超过 `contextWindowTokens`，旧式
 * `max(1, window - system)` 会把「留给对话历史的 token 档位」钳成 **1**，
 * → `budgetChars` 几乎为 0，**prior user/assistant 整段被剪光**，仅剩当前尾巴；
 * 模型侧却以为「会话有历史」（磁盘/会话统计仍在），就出现「看得到统计、读不到上文」。
 *
 * 这里对 system 预估做顶格，并为 messages 保底一块窗口，不把历史误剪成单行。
 */
const MIN_MESSAGE_HISTORY_TOKEN_UNITS = 4096;

// ============== 工具可修剪性判定 (对应 pruner/tools.ts) ==============

/**
 * 工具修剪规则
 *
 * ContextPruningToolMatch
 * allow 为空时所有非 deny 工具都可修剪
 */
export type ContextPruningToolMatch = {
  /** 白名单（glob 风格，如 ["exec", "file_*"]）。空数组 = 全部可修剪 */
  allow?: string[];
  /** 黑名单（优先级高于 allow） */
  deny?: string[];
};

/**
 * 构建工具可修剪性谓词
 *
 * Tool prunability predicate
 * 逻辑: deny 优先 → allow 空则全允许 → 否则匹配 allow
 */
function makeToolPrunablePredicate(
  match?: ContextPruningToolMatch,
): (toolName: string) => boolean {
  if (!match) return () => true;

  const deny = match.deny ?? [];
  const allow = match.allow ?? [];

  return (toolName: string) => {
    const normalized = toolName.trim().toLowerCase();
    if (deny.some((pattern) => matchGlob(normalized, pattern.toLowerCase()))) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return allow.some((pattern) => matchGlob(normalized, pattern.toLowerCase()));
  };
}

/** 简易 glob 匹配 (仅支持 * 通配符)。使用字符串 indexOf 避免 regex 回溯 ReDoS。 */
function matchGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;

  const parts = pattern.split("*");
  // 开头必须匹配第一个字面片段
  if (parts[0] !== "" && !value.startsWith(parts[0])) return false;
  let pos = parts[0].length;

  // 中间片段按序匹配
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === "") continue;
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1) return false;
    pos = idx + parts[i].length;
  }

  // 结尾必须匹配最后一个字面片段
  const last = parts[parts.length - 1];
  if (last === "") return true;
  return value.length >= pos + last.length && value.endsWith(last);
}

// ============== 配置 ==============

export type ContextPruningSettings = {
  /** 历史消息占上下文窗口的最大比例 (消息级丢弃预算) */
  maxHistoryShare: number;
  /** 保护最近 N 条 assistant 消息不被丢弃 */
  keepLastAssistants: number;
  /** 触发 soft trim 的比例阈值 */
  softTrimRatio: number;
  /** 触发 hard clear 的比例阈值 */
  hardClearRatio: number;
  /** Hard clear 最低可修剪字符数 */
  minPrunableToolChars: number;
  /** Soft trim 参数 */
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  /** Hard clear 参数 */
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
  /** 工具可修剪规则 */
  tools: ContextPruningToolMatch;
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: ContextPruningSettings = {
  maxHistoryShare: 0.5,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
  tools: {},
};

export type PruneResult = {
  messages: Message[];
  droppedMessages: Message[];
  trimmedToolResults: number;
  hardClearedToolResults: number;
  totalChars: number;
  keptChars: number;
  droppedChars: number;
  budgetChars: number;
};

function clampShare(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resolveEnvPruningSettings(base: ContextPruningSettings): Partial<ContextPruningSettings> {
  return {
    maxHistoryShare: parseEnvNumber('DMOSS_CONTEXT_MAX_HISTORY_SHARE'),
    keepLastAssistants: parseEnvNumber('DMOSS_CONTEXT_KEEP_LAST_ASSISTANTS'),
    softTrimRatio: parseEnvNumber('DMOSS_CONTEXT_SOFT_TRIM_RATIO'),
    hardClearRatio: parseEnvNumber('DMOSS_CONTEXT_HARD_CLEAR_RATIO'),
    minPrunableToolChars: base.minPrunableToolChars,
  };
}

export function resolvePruningSettings(
  raw?: Partial<ContextPruningSettings>,
): ContextPruningSettings {
  const d = DEFAULT_CONTEXT_PRUNING_SETTINGS;
  const envSettings = resolveEnvPruningSettings(d);
  const source = {
    ...envSettings,
    ...(raw ?? {}),
  };
  return {
    maxHistoryShare: clampShare(source.maxHistoryShare ?? d.maxHistoryShare, d.maxHistoryShare),
    keepLastAssistants: clampPositiveInt(source.keepLastAssistants, d.keepLastAssistants),
    softTrimRatio: clampShare(source.softTrimRatio ?? d.softTrimRatio, d.softTrimRatio),
    hardClearRatio: clampShare(source.hardClearRatio ?? d.hardClearRatio, d.hardClearRatio),
    minPrunableToolChars: clampPositiveInt(source.minPrunableToolChars, d.minPrunableToolChars),
    softTrim: {
      maxChars: clampPositiveInt(source.softTrim?.maxChars, d.softTrim.maxChars),
      headChars: clampPositiveInt(source.softTrim?.headChars, d.softTrim.headChars),
      tailChars: clampPositiveInt(source.softTrim?.tailChars, d.softTrim.tailChars),
    },
    hardClear: {
      enabled: source.hardClear?.enabled ?? d.hardClear.enabled,
      placeholder: source.hardClear?.placeholder ?? d.hardClear.placeholder,
    },
    tools: source.tools ?? d.tools,
  };
}

// ============== Layer 1: Soft Trim (对应 pruner.ts softTrimToolResultMessage) ==============

function cloneMessage(message: Message, content: Message["content"]): Message {
  return { ...message, content };
}

/**
 * 判断 tool_result block 是否包含不可修剪内容
 *
 * 图片等 tool result 不可修剪
 * Mini 的 ContentBlock 暂不支持 image 类型，预留此检查
 */
function isToolResultProtected(_block: ContentBlock): boolean {
  // Mini 的 ContentBlock 只有 text/tool_use/tool_result
  return false;
}

/**
 * 对单个 tool_result block 执行 soft trim
 *
 * Soft trim: truncate long tool results keeping head + tail
 * 保留 head + tail，丢弃中间，添加说明
 */
function softTrimToolResultBlock(
  block: ContentBlock,
  settings: ContextPruningSettings["softTrim"],
  isPrunable: (toolName: string) => boolean,
): { block: ContentBlock; trimmed: boolean } {
  if (block.type !== "tool_result") {
    return { block, trimmed: false };
  }

  // 受保护的 tool result 不修剪
  if (isToolResultProtected(block)) {
    return { block, trimmed: false };
  }

  // 工具可修剪性检查（用工具名，不是 tool_use_id）
  if (block.name && !isPrunable(block.name)) {
    return { block, trimmed: false };
  }

  const raw = typeof block.content === "string" ? block.content : "";
  const rawLen = raw.length;
  if (rawLen <= settings.maxChars) {
    return { block, trimmed: false };
  }

  const headChars = Math.max(0, settings.headChars);
  const tailChars = Math.max(0, settings.tailChars);
  if (headChars + tailChars >= rawLen) {
    return { block, trimmed: false };
  }

  const head = raw.slice(0, headChars);
  const tail = raw.slice(rawLen - tailChars);
  const trimmedText =
    `${head}\n...\n${tail}\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return {
    block: { ...block, content: trimmedText },
    trimmed: true,
  };
}

function applySoftTrim(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
): { messages: Message[]; trimmedToolResults: number } {
  let trimmedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      const result = softTrimToolResultBlock(block, settings.softTrim, isPrunable);
      if (result.trimmed) {
        trimmedToolResults += 1;
        didChange = true;
      }
      nextBlocks.push(result.block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, trimmedToolResults };
}

// ============== Layer 2: Hard Clear (对应 pruner.ts hard clear 逻辑) ==============

/**
 * 计算可修剪工具结果的总字符数
 */
function countPrunableToolChars(
  messages: Message[],
  isPrunable: (toolName: string) => boolean,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (isToolResultProtected(block)) continue;
      if (block.name && !isPrunable(block.name)) continue;
      const text = typeof block.content === "string" ? block.content : "";
      total += text.length;
    }
  }
  return total;
}

/**
 * 对可修剪工具结果执行 hard clear
 *
 * Hard clear: replace prunable tool results with placeholder
 * 用占位符替换内容，保留消息结构和 toolCallId（便于调试追溯）
 */
function applyHardClear(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
  charWindow: number,
): { messages: Message[]; hardClearedToolResults: number } {
  if (!settings.hardClear.enabled) {
    return { messages, hardClearedToolResults: 0 };
  }

  let totalChars = estimateMessagesChars(messages);
  const ratio = totalChars / charWindow;

  // 仅在超过 hardClearRatio 时触发
  if (ratio < settings.hardClearRatio) {
    return { messages, hardClearedToolResults: 0 };
  }

  // 可修剪字符数不足时不触发
  const prunableChars = countPrunableToolChars(messages, isPrunable);
  if (prunableChars < settings.minPrunableToolChars) {
    return { messages, hardClearedToolResults: 0 };
  }

  let hardClearedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];

    for (const block of msg.content) {
      // 仅 clear 可修剪的 tool_result（非图片）
      if (
        block.type === "tool_result" &&
        !isToolResultProtected(block) &&
        typeof block.content === "string" &&
        block.content.length > 0
      ) {
        const canPrune = !block.name || isPrunable(block.name);

        if (canPrune) {
          // 比例已降到阈值以下时停止
          const currentRatio = totalChars / charWindow;
          if (currentRatio < settings.hardClearRatio) {
            nextBlocks.push(block);
            continue;
          }

          const beforeLen = block.content.length;
          const clearedBlock: ContentBlock = {
            ...block,
            content: settings.hardClear.placeholder,
          };
          nextBlocks.push(clearedBlock);
          totalChars -= beforeLen - settings.hardClear.placeholder.length;
          hardClearedToolResults += 1;
          didChange = true;
          continue;
        }
      }

      nextBlocks.push(block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, hardClearedToolResults };
}

// ============== Layer 3: Message Drop (对应 compaction.ts pruneHistoryForContextShare) ==============

/**
 * 查找 assistant cutoff 保护边界
 *
 * keepLastAssistants protection
 * 从后往前数，保护最近 N 条 assistant 消息及其之后的所有消息
 */
function findAssistantCutoffIndex(messages: Message[], keepLastAssistants: number): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    remaining -= 1;
    if (remaining === 0) return i;
  }
  return null;
}

/**
 * 从后往前填充预算
 *
 * 保留尽可能多的最近消息，直到超出 budget
 */
function sliceWithinBudget(messages: Message[], budgetChars: number): Message[] {
  const kept: Message[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = estimateMessageChars(msg);
    if (used + chars > budgetChars && kept.length > 0) break;
    kept.push(msg);
    used += chars;
  }
  kept.reverse();
  return kept;
}

function collectToolUseIds(msg: Message): string[] {
  if (typeof msg.content === "string") return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.id) ids.push(block.id);
  }
  return ids;
}

function collectToolResultIds(msg: Message): string[] {
  if (typeof msg.content === "string") return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_result" && block.tool_use_id) ids.push(block.tool_use_id);
  }
  return ids;
}

function expandKeptWithToolUseParents(messages: Message[], kept: Message[]): Message[] {
  const keptSet = new Set(kept);
  const toolUseMessageById = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const id of collectToolUseIds(msg)) {
      if (!toolUseMessageById.has(id)) toolUseMessageById.set(id, msg);
    }
  }

  let changed = false;
  for (const msg of kept) {
    if (msg.role !== "user") continue;
    for (const id of collectToolResultIds(msg)) {
      const parent = toolUseMessageById.get(id);
      if (parent && !keptSet.has(parent)) {
        keptSet.add(parent);
        changed = true;
      }
    }
  }

  return changed ? messages.filter((msg) => keptSet.has(msg)) : kept;
}

function isCompactionSummaryMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") {
    return message.content.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX);
  }
  return message.content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX),
  );
}

function protectLatestCompactionSummary(messages: Message[], kept: Message[]): Message[] {
  let latestSummary: Message | undefined;
  for (const message of messages) {
    if (isCompactionSummaryMessage(message)) {
      latestSummary = message;
    }
  }
  if (!latestSummary || kept.includes(latestSummary)) {
    return kept;
  }
  const keptSet = new Set(kept);
  keptSet.add(latestSummary);
  return messages.filter((message) => keptSet.has(message));
}

// ============== 主入口 ==============

/**
 * 三层递进上下文修剪
 *
 * Main entry: three-layer context pruning
 * 执行顺序: soft trim → hard clear → message drop
 */
export function pruneContextMessages(params: {
  messages: Message[];
  contextWindowTokens: number;
  systemPromptTokens?: number;
  /** 与 estimatePromptUnitsForContextWindow / DMOSS_CONTEXT_CHARS_PER_TOKEN_UNIT 对齐，默认 4 */
  charsPerTokenUnit?: number;
  settings?: Partial<ContextPruningSettings>;
}): PruneResult {
  const settings = resolvePruningSettings(params.settings);

  const contextWindowTokensAll = Math.max(1, Math.floor(params.contextWindowTokens));
  const systemTokensRaw = Math.max(0, params.systemPromptTokens ?? 0);

  /** 小窗口时用比例下限，避免 4k floor 在吃紧模型上_reserve 过猛 */
  const minMsgTokenFloor = Math.min(
    MIN_MESSAGE_HISTORY_TOKEN_UNITS,
    Math.max(512, Math.floor(contextWindowTokensAll * 0.2)),
  );
  const cappedSystemTokens = Math.min(
    systemTokensRaw,
    Math.max(0, contextWindowTokensAll - minMsgTokenFloor),
  );
  /** 等价于「在总窗口内，system 最多占到 window - minMsgTokenFloor」再做减法 */
  const contextTokens = Math.max(
    minMsgTokenFloor,
    contextWindowTokensAll - cappedSystemTokens,
  );

  const charsPerUnit = Math.max(1, params.charsPerTokenUnit ?? CHARS_PER_TOKEN_ESTIMATE);
  const charWindow = contextTokens * charsPerUnit;
  const budgetChars = Math.max(1, Math.floor(charWindow * settings.maxHistoryShare));
  const isPrunable = makeToolPrunablePredicate(settings.tools);

  let current = params.messages;
  let trimmedToolResults = 0;
  let hardClearedToolResults = 0;

  // Layer 1: Soft Trim — 比例超过 softTrimRatio 时触发
  const totalChars = estimateMessagesChars(current);
  const ratio = totalChars / charWindow;
  if (ratio > settings.softTrimRatio) {
    const trimResult = applySoftTrim(current, settings, isPrunable);
    current = trimResult.messages;
    trimmedToolResults = trimResult.trimmedToolResults;
  }

  // Layer 2: Hard Clear — soft trim 后仍超标时触发
  const afterSoftTrimChars = estimateMessagesChars(current);
  const afterSoftTrimRatio = afterSoftTrimChars / charWindow;
  if (afterSoftTrimRatio > settings.hardClearRatio) {
    const clearResult = applyHardClear(current, settings, isPrunable, charWindow);
    current = clearResult.messages;
    hardClearedToolResults = clearResult.hardClearedToolResults;
  }

  // Layer 3: Message Drop — 超出 history budget 时丢弃旧消息
  const afterClearChars = estimateMessagesChars(current);
  if (afterClearChars <= budgetChars) {
    return {
      messages: current,
      droppedMessages: [],
      trimmedToolResults,
      hardClearedToolResults,
      totalChars: afterClearChars,
      keptChars: afterClearChars,
      droppedChars: 0,
      budgetChars,
    };
  }

  const cutoffIndex = findAssistantCutoffIndex(current, settings.keepLastAssistants);
  const protectedIndex = cutoffIndex ?? 0;
  const protectedMessages = current.slice(protectedIndex);
  const protectedChars = estimateMessagesChars(protectedMessages);

  let kept: Message[];
  if (protectedChars > budgetChars) {
    kept = sliceWithinBudget(current, budgetChars);
  } else {
    kept = [...protectedMessages];
    let remaining = budgetChars - protectedChars;
    for (let i = protectedIndex - 1; i >= 0; i--) {
      const msg = current[i];
      const msgChars = estimateMessageChars(msg);
      if (msgChars > remaining) break;
      kept.unshift(msg);
      remaining -= msgChars;
    }
    if (kept.length === 0) {
      kept = sliceWithinBudget(current, budgetChars);
    }
  }
  kept = protectLatestCompactionSummary(current, kept);
  kept = expandKeptWithToolUseParents(current, kept);

  const keptSet = new Set(kept);
  const droppedMessages = current.filter((msg) => !keptSet.has(msg));
  const keptChars = estimateMessagesChars(kept);
  const droppedChars = Math.max(0, afterClearChars - keptChars);

  return {
    messages: kept,
    droppedMessages,
    trimmedToolResults,
    hardClearedToolResults,
    totalChars: afterClearChars,
    keptChars,
    droppedChars,
    budgetChars,
  };
}
