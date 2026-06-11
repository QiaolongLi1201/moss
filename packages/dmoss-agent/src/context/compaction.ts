import fs from "node:fs/promises";
import path from "node:path";
import {
  createCompactionSummaryMessage,
  type Message,
} from "../core/session/session-jsonl.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateMessagesChars,
  estimatePromptUnitsForContextWindow,
  estimateTokensForText,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./tokens.js";
import { assertSandboxPath } from "../safety/sandbox-paths.js";
import { sanitizeSecrets } from "../safety/secret-sanitizer.js";
import {
  pruneContextMessages,
  type ContextPruningSettings,
  type PruneResult,
} from "./pruning.js";
import { getRootLogger } from "../logger.js";
import type { RemoteCompactProvider } from "./remote-compaction.js";
import { buildDeterministicCompactionSummary } from "./deterministic-summary.js";
import {
  extractCompactionSummaryText,
  isCompactionSummaryMessage,
  mergePriorCompactionSummaries,
} from "./summary-checkpoint-merge.js";
import {
  MERGE_SUMMARIES_INSTRUCTIONS,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./compaction-prompts.js";

const log = getRootLogger().child("agent:compaction");

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  /**
   * After compaction, re-read the current on-disk contents of the most recently
   * read/modified files and append them to the summary, so the model keeps its
   * working set instead of having to re-read every file ("amnesia re-read").
   * Default on. See POST_COMPACT_* budget constants below.
   */
  restoreFileContents: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 20_000,
  restoreFileContents: true,
};

// Post-compaction file readback budget. Mirrors the reference implementation
// Restore at most a handful of the
// most recent working-set files, cap each file, and cap the total so readback
// can never dominate the freed context window. 50K total ≈ 5K reserveTokens
// headroom is intentionally comfortable: readback runs once per compaction and
// is appended to the single summary message, so it is self-limiting.
/** Max number of recent files to restore after compaction. */
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
/** Total token budget across all restored files. */
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
/** Per-file token cap; larger files are head-truncated with a marker. */
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;

export const DEFAULT_SUMMARY_MAX_TOKENS = 900;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
function extractSummaryTag(raw: string): string {
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  return match ? match[1].trim() : raw.trim();
}

type FileOps = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
  /**
   * Last-touch recency in chronological order: each path appears once, at the
   * position of its MOST recent operation. droppedMessages are walked oldest →
   * newest, so the tail of this list holds the most recently touched files —
   * the working set worth restoring. `modified` marks write/edit (preferred
   * over plain reads when selecting files to restore).
   */
  recency: Array<{ path: string; modified: boolean }>;
};

function createFileOps(): FileOps {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
    recency: [],
  };
}

function touchRecency(fileOps: FileOps, filePath: string, modified: boolean): void {
  const existingIdx = fileOps.recency.findIndex((e) => e.path === filePath);
  if (existingIdx !== -1) {
    const existing = fileOps.recency[existingIdx];
    fileOps.recency.splice(existingIdx, 1);
    fileOps.recency.push({ path: filePath, modified: existing.modified || modified });
    return;
  }
  fileOps.recency.push({ path: filePath, modified });
}

function extractFileOpsFromMessage(message: Message, fileOps: FileOps): void {
  if (message.role !== "assistant") {
    return;
  }
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const args = block.input;
    if (!args || typeof args !== "object") {
      continue;
    }
    const path =
      typeof args.path === "string" ? args.path :
      typeof args.file_path === "string" ? args.file_path :
      undefined;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
      case "read_file":
        fileOps.read.add(path);
        touchRecency(fileOps, path, false);
        break;
      case "write":
      case "write_file":
        fileOps.written.add(path);
        touchRecency(fileOps, path, true);
        break;
      case "edit":
      case "multi_edit":
      case "notebook_edit":
        fileOps.edited.add(path);
        touchRecency(fileOps, path, true);
        break;
    }
  }
}

function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Select the most-recent working-set files to restore: walk recency newest →
 * oldest, prefer modified over read-only, dedup, cap at `maxFiles`. Only paths
 * still present in fileOps Sets are eligible, so M3 scope isolation (which
 * prunes those Sets) is honored without re-implementing the scope check here.
 */
function selectFilesToRestore(fileOps: FileOps, maxFiles: number): string[] {
  const inScope = (p: string): boolean =>
    fileOps.read.has(p) || fileOps.written.has(p) || fileOps.edited.has(p);
  const newestFirst = [...fileOps.recency].reverse().filter((e) => inScope(e.path));
  const modified = newestFirst.filter((e) => e.modified).map((e) => e.path);
  const readOnly = newestFirst.filter((e) => !e.modified).map((e) => e.path);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const p of [...modified, ...readOnly]) {
    if (seen.has(p)) continue;
    seen.add(p);
    ordered.push(p);
    if (ordered.length >= maxFiles) break;
  }
  return ordered;
}

/** Head-truncate file content to ~maxTokens, appending a truncation marker. */
function truncateToTokenBudget(content: string, maxTokens: number): string {
  if (estimateTokensForText(content) <= maxTokens) {
    return content;
  }
  // Char-budget approximation (chars ≈ tokens * 4); good enough since the
  // estimate below is the authoritative gate for the total budget.
  const charBudget = Math.max(0, maxTokens * CHARS_PER_TOKEN_ESTIMATE);
  const head = content.slice(0, charBudget);
  return `${head}\n\n[... truncated: file exceeds ${maxTokens} token restore cap; read it again for the rest]`;
}

/**
 * Re-read the current on-disk contents of the most recently read/modified files
 * and format them as `<restored-file>` blocks to append after the summary.
 *
 * Budget-safe: at most POST_COMPACT_MAX_FILES_TO_RESTORE files, each capped at
 * POST_COMPACT_MAX_TOKENS_PER_FILE, total capped at POST_COMPACT_TOKEN_BUDGET.
 * Sandbox-safe: every path is resolved through assertSandboxPath against the
 * workspace root before reading. Missing/deleted/out-of-sandbox/unreadable
 * files are skipped silently — readback is best-effort and never throws.
 */
async function restoreRecentFileContents(params: {
  fileOps: FileOps;
  workspaceDir: string;
  maxFiles: number;
  perFileTokenBudget: number;
  totalTokenBudget: number;
}): Promise<string> {
  const candidates = selectFilesToRestore(params.fileOps, params.maxFiles);
  if (candidates.length === 0) {
    return "";
  }

  const blocks: string[] = [];
  let usedTokens = 0;
  for (const filePath of candidates) {
    let resolved: string;
    try {
      ({ resolved } = await assertSandboxPath({
        filePath,
        cwd: params.workspaceDir,
        root: params.workspaceDir,
      }));
    } catch {
      continue; // escapes sandbox / symlink — skip gracefully
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolved, "utf-8");
    } catch {
      continue; // deleted / unreadable / binary — skip gracefully
    }

    const safe = sanitizeSecrets(raw);
    const body = truncateToTokenBudget(safe, params.perFileTokenBudget);
    const block = `<restored-file path="${filePath}">\n${body}\n</restored-file>`;
    const blockTokens = estimateTokensForText(block);
    if (usedTokens + blockTokens > params.totalTokenBudget) {
      continue; // would blow the total budget — skip this file, try the rest
    }
    usedTokens += blockTokens;
    blocks.push(block);
  }

  if (blocks.length === 0) {
    return "";
  }
  return (
    `\n\n<restored-files>\n` +
    `Current on-disk contents of the most recently used files, restored after ` +
    `compaction so you keep your working set. Do not re-read these unless you ` +
    `suspect they changed.\n\n` +
    `${blocks.join("\n\n")}\n` +
    `</restored-files>`
  );
}

export type SummarizeFn = (params: {
  system: string;
  userPrompt: string;
  maxTokens: number;
}) => Promise<string>;

function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

export function computeAdaptiveChunkRatio(messages: Message[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

export function splitMessagesByTokenShare(messages: Message[], parts = DEFAULT_PARTS): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function chunkMessagesByMaxTokens(messages: Message[], maxTokens: number): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (current.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;

    if (messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function isOversizedForSummary(msg: Message, contextWindow: number): boolean {
  const tokens = estimateMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

function extractUserText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text) {
        parts.push(`[User]: ${text}`);
      }
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content
          .filter((block) => block.type === "tool_result")
          .map((block) => block.content ?? "")
          .filter(Boolean);
        for (const result of toolResults) {
          parts.push(`[Tool result]: ${result}`);
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            if (block.text) {
              textParts.push(block.text);
            }
            continue;
          }
          if (block.type === "tool_use") {
            const args = block.input ?? {};
            const argsStr = Object.entries(args)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(", ");
            toolCalls.push(`${block.name ?? "tool"}(${argsStr})`);
          }
        }
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    }
  }
  return parts.join("\n\n");
}

async function generateSummary(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  let basePrompt = params.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (params.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${params.customInstructions}`;
  }
  const conversationText = serializeConversation(params.messages);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (params.previousSummary) {
    prompt += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += basePrompt;

  const raw = await params.summarize({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: params.maxTokens,
  });

  // 提取 <summary> 标签内容（如果 LLM 遵循了两段式输出格式）
  return extractSummaryTag(raw);
}

async function summarizeChunks(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  let summary = params.previousSummary;
  for (const chunk of chunks) {
    summary = await generateSummary({
      messages: chunk,
      summarize: params.summarize,
      maxTokens: params.maxTokens,
      customInstructions: params.customInstructions,
      previousSummary: summary,
    });
  }
  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

async function summarizeWithFallback(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  try {
    return await summarizeChunks(params);
  } catch (e) {
    log.warn('summarizeChunks failed, falling back to smaller chunks', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const smallMessages: Message[] = [];
  const oversizedNotes: string[] = [];
  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      const tokens = estimateMessageTokens(msg);
      oversizedNotes.push(`[Large ${msg.role} (~${Math.round(tokens / 1000)}K tokens) omitted]`);
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partial = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partial + notes;
    } catch (e) {
      log.warn('smaller-chunks fallback also failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const fallback = `Context contained ${params.messages.length} messages. Summary unavailable due to size limits.`;
  return oversizedNotes.length > 0 ? `${fallback}\n\n${oversizedNotes.join("\n")}` : fallback;
}

export async function summarizeInStages(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  const summaryMessages: Message[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

export function shouldTriggerCompaction(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
  systemPrompt?: string;
  charsPerTokenUnit?: number;
  includeThinking?: boolean;
}): boolean {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...params.settings,
  };
  if (!settings.enabled) return false;
  const totalTokens =
    params.systemPrompt !== undefined && params.charsPerTokenUnit !== undefined
      ? estimatePromptUnitsForContextWindow({
          messages: params.messages,
          systemPrompt: params.systemPrompt,
          charsPerTokenUnit: params.charsPerTokenUnit,
          effectiveContextWindowTokens: params.contextWindowTokens,
          includeThinking: params.includeThinking,
        })
      : estimateMessagesTokens(params.messages, { includeThinking: params.includeThinking });
  return totalTokens > params.contextWindowTokens - settings.reserveTokens;
}

export function shouldProactiveCompact(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
  includeThinking?: boolean;
}): boolean {
  const settings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.settings };
  if (!settings.enabled) return false;

  const totalTokens = estimateMessagesTokens(params.messages, { includeThinking: params.includeThinking });
  const usageRatio = totalTokens / params.contextWindowTokens;

  if (usageRatio < 0.6) return false;

  const recentMessages = params.messages.slice(-6);
  const toolOnlyRounds = recentMessages.filter(
    m => m.role === 'assistant' && Array.isArray(m.content) &&
         m.content.every(b => b.type === 'tool_use')
  ).length;

  if (toolOnlyRounds >= 3 && usageRatio > 0.65) return true;

  const lastMsg = params.messages[params.messages.length - 1];
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    const toolResultTokens = lastMsg.content
      .filter(b => b.type === 'tool_result')
      .reduce((sum, b) => sum + (typeof b.content === 'string' ? b.content.length : 0) / 4, 0);
    if (toolResultTokens > params.contextWindowTokens * 0.4) return true;
  }

  return false;
}

export async function buildCompactionSummary(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens?: number;
  customInstructions?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return DEFAULT_SUMMARY_FALLBACK;
  }
  const adaptiveRatio = computeAdaptiveChunkRatio(params.messages, params.contextWindowTokens);
  const maxChunkTokens = Math.max(1, Math.floor(params.contextWindowTokens * adaptiveRatio));
  const reserveTokens = params.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxTokens = Math.max(64, Math.floor(params.maxTokens ?? (0.8 * reserveTokens)));

  return summarizeInStages({
    messages: params.messages,
    summarize: params.summarize,
    maxTokens,
    maxChunkTokens,
    contextWindow: params.contextWindowTokens,
    customInstructions: params.customInstructions,
  });
}

async function runRemoteCompaction(params: {
  remoteCompactProvider: RemoteCompactProvider;
  localSummarize: SummarizeFn;
  contextWindowTokens: number;
  reserveTokens: number;
  customInstructions?: string;
  droppedMessages: Message[];
  systemPrompt?: string;
}): Promise<string> {
  const { hybridCompact } = await import("./remote-compaction.js");
  const hybrid = await hybridCompact(
    {
      remoteProvider: params.remoteCompactProvider,
      localSummarize: params.localSummarize,
      contextWindowTokens: params.contextWindowTokens,
      reserveTokens: params.reserveTokens,
      customInstructions: params.customInstructions,
    },
    params.droppedMessages,
    params.systemPrompt,
  );
  log.info("compaction summary source", { method: hybrid.method });
  return hybrid.summary;
}

async function runLlmCompaction(params: {
  summarize: SummarizeFn;
  droppedMessages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens: number;
  customInstructions?: string;
}): Promise<string> {
  return buildCompactionSummary({
    summarize: params.summarize,
    messages: params.droppedMessages,
    contextWindowTokens: params.contextWindowTokens,
    maxTokens: params.maxTokens,
    reserveTokens: params.reserveTokens,
    customInstructions: params.customInstructions,
  });
}

export async function compactHistoryIfNeeded(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactionSettings?: Partial<CompactionSettings>;
  systemPrompt?: string;
  charsPerTokenUnit?: number;
  maxTokens?: number;
  skipLlmCompaction?: boolean;
  forceCompaction?: boolean;
  remoteCompactProvider?: RemoteCompactProvider;
  customInstructions?: string;
  includeThinking?: boolean;
  /** M3: Optional workspace directory for file ops scope isolation. */
  workspaceDir?: string;
}): Promise<{
  summary?: string;
  summaryMessage?: Message;
  pruneResult: PruneResult;
  degraded?: boolean;
}> {
  const charsPerUnitBase = Math.max(1, params.charsPerTokenUnit ?? CHARS_PER_TOKEN_ESTIMATE);
  const estimateOptions = { includeThinking: params.includeThinking };
  const rawTotalChars = estimateMessagesChars(params.messages, estimateOptions) + (params.systemPrompt?.length ?? 0);
  const pruneCharsPerUnit =
    rawTotalChars / params.contextWindowTokens >= 0.85 ? 1 : charsPerUnitBase;
  const systemPromptTokens = params.systemPrompt
    ? Math.ceil(
        estimatePromptUnitsForContextWindow({
          messages: [],
          systemPrompt: params.systemPrompt,
          charsPerTokenUnit: pruneCharsPerUnit,
          effectiveContextWindowTokens: params.contextWindowTokens,
          includeThinking: params.includeThinking,
        }),
      )
    : undefined;

  const pruneResult = pruneContextMessages({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    systemPromptTokens,
    charsPerTokenUnit: pruneCharsPerUnit,
    includeThinking: params.includeThinking,
    settings: params.pruningSettings,
  });
  const priorCompactionSummaries = params.messages
    .filter(isCompactionSummaryMessage)
    .map(extractCompactionSummaryText)
    .filter((summary): summary is string => Boolean(summary));
  if (priorCompactionSummaries.length > 0) {
    pruneResult.messages = pruneResult.messages.filter(
      (message) => !isCompactionSummaryMessage(message),
    );
    pruneResult.droppedMessages = pruneResult.droppedMessages.filter(
      (message) => !isCompactionSummaryMessage(message),
    );
    const recalcKept = pruneResult.messages.reduce((s, m) => s + JSON.stringify(m).length, 0);
    const recalcDropped = pruneResult.droppedMessages.reduce(
      (s, m) => s + JSON.stringify(m).length,
      0,
    );
    pruneResult.totalChars = recalcKept + recalcDropped;
    pruneResult.keptChars = recalcKept;
    pruneResult.droppedChars = recalcDropped;
  }

  const shouldCompact =
    Boolean(params.forceCompaction) ||
    pruneResult.droppedMessages.length > 0 ||
    shouldTriggerCompaction({
      messages: params.messages,
      contextWindowTokens: params.contextWindowTokens,
      settings: params.compactionSettings,
      systemPrompt: params.systemPrompt,
      charsPerTokenUnit: charsPerUnitBase,
      includeThinking: params.includeThinking,
    });

  if (!shouldCompact) {
    return { pruneResult };
  }

  if (pruneResult.droppedMessages.length === 0) {
    const totalTokens = estimateMessagesTokens(params.messages, estimateOptions);
    const threshold = params.contextWindowTokens * 0.7;
    if (!params.forceCompaction && totalTokens <= threshold) {
      return { pruneResult };
    }
    const keepLastN = Math.max(4, Math.ceil(params.messages.length * 0.5));
    const dropCount = Math.max(1, params.messages.length - keepLastN);
    pruneResult.droppedMessages.push(...params.messages.slice(0, dropCount));
    pruneResult.messages = params.messages.slice(dropCount);

    const recalcKept = pruneResult.messages.reduce((s, m) => s + JSON.stringify(m).length, 0);
    const recalcDropped = pruneResult.droppedMessages.reduce((s, m) => s + JSON.stringify(m).length, 0);
    pruneResult.totalChars = recalcKept + recalcDropped;
    pruneResult.keptChars = recalcKept;
    pruneResult.droppedChars = recalcDropped;
  }

  if (params.skipLlmCompaction) {
    const summary = buildDeterministicCompactionSummary(
      pruneResult.droppedMessages,
      "LLM 摘要已熔断，使用本地规则摘要兜底",
    );
    return {
      summary,
      summaryMessage: createCompactionSummaryMessage(summary, Date.now()),
      pruneResult,
      degraded: true,
    };
  }

  const resolvedSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.compactionSettings };
  let summary: string;
  let degraded = false;

  try {
    if (params.remoteCompactProvider) {
      summary = await runRemoteCompaction({
        remoteCompactProvider: params.remoteCompactProvider,
        localSummarize: params.summarize,
        contextWindowTokens: params.contextWindowTokens,
        reserveTokens: resolvedSettings.reserveTokens,
        customInstructions: params.customInstructions,
        droppedMessages: pruneResult.droppedMessages,
        systemPrompt: params.systemPrompt,
      });
    } else {
      summary = await runLlmCompaction({
        summarize: params.summarize,
        droppedMessages: pruneResult.droppedMessages,
        contextWindowTokens: params.contextWindowTokens,
        maxTokens: params.maxTokens,
        reserveTokens: resolvedSettings.reserveTokens,
        customInstructions: params.customInstructions,
      });
    }
  } catch (err) {
    log.warn("LLM compaction failed; using deterministic fallback summary", {
      error: err instanceof Error ? err.message : String(err),
    });
    summary = buildDeterministicCompactionSummary(
      pruneResult.droppedMessages,
      "LLM 摘要失败，使用本地规则摘要兜底",
    );
    degraded = true;
  }
  if (
    !summary ||
    !summary.trim() ||
    summary.includes("Summary unavailable due to size limits")
  ) {
    summary = buildDeterministicCompactionSummary(
      pruneResult.droppedMessages,
      "LLM 摘要为空或不可用，使用本地规则摘要兜底",
    );
    degraded = true;
  }
  summary = mergePriorCompactionSummaries(summary, priorCompactionSummaries);
  const fileOps = createFileOps();
  for (const message of pruneResult.droppedMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }
  // M3: scope isolation — filter file paths to workspace when configured.
  if (params.workspaceDir) {
    const ws = params.workspaceDir.replace(/[/\\]+$/, '');
    const inScope = (p: string) => p === ws || p.startsWith(ws + '/') || p.startsWith(ws + '\\') || !path.isAbsolute(p);
    fileOps.read = new Set([...fileOps.read].filter(inScope));
    fileOps.written = new Set([...fileOps.written].filter(inScope));
    fileOps.edited = new Set([...fileOps.edited].filter(inScope));
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  // Post-compaction file readback: re-inject current contents of the recent
  // working set so the model does not have to re-read every file after a
  // compaction. Appended after the summary + file lists; bounded by the
  // POST_COMPACT_* budgets and the sandbox. Best-effort: never blocks compaction.
  if (resolvedSettings.restoreFileContents) {
    const restoreRoot = params.workspaceDir ?? process.cwd();
    try {
      summary += await restoreRecentFileContents({
        fileOps,
        workspaceDir: restoreRoot,
        maxFiles: POST_COMPACT_MAX_FILES_TO_RESTORE,
        perFileTokenBudget: POST_COMPACT_MAX_TOKENS_PER_FILE,
        totalTokenBudget: POST_COMPACT_TOKEN_BUDGET,
      });
    } catch (err) {
      log.warn("post-compaction file readback failed; skipping", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summaryMessage: Message = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    pruneResult,
    degraded: degraded || undefined,
  };
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_HISTORY_SHARE = 0.5;
export const DEFAULT_CONTEXT_WINDOW_CHARS =
  DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
