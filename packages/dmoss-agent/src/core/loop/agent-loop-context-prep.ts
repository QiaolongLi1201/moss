import type {
  Context as PiContext,
  Model,
} from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { Message } from '../session/session-jsonl.js';
import type { Tool } from '../tools/tool-types.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import type { ContextPruningSettings, PruneResult } from '../../context/pruning.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import type { AgentLoopCompactionOutcome } from './agent-loop-compaction.js';
import {
  estimateMessageChars,
  estimateMessageTokens,
  estimatePromptUnitsForContextWindow,
  estimateMessagesChars,
} from '../../context/tokens.js';
import { pruneContextMessages } from '../../context/pruning.js';
import { getRootLogger } from '../../logger.js';
import { runPerTurnContextManagement } from './per-turn-context-management.js';
import {
  shouldProactiveCompactByWindowEconomics,
} from '../../context/window-economics.js';
import { shouldTriggerCompaction } from '../../context/compaction.js';
import { repairMissingToolResults } from '../tools/tool-result-roundtrip-guard.js';
import {
  runProactiveWindowCompaction,
  runPromptPruneCompaction,
} from './agent-loop-compaction.js';
import {
  shouldSuppressReasoningForToolFollowUpRound,
} from './follow-up-guard.js';
import { hasAssistantThinkingHistory } from './agent-loop-assistant-turn.js';
import { convertMessagesToPi } from '../tools/message-convert.js';
import {
  checkPromptPrefixStable,
  checkToolOrderConsistency,
  snapshotMessagesForPrefixCheck,
} from '../llm/prompt-prefix-cache.js';

const log = getRootLogger().child('agent:context-prep');

// ─── Existing pure helpers ─────────────────────────────────────────

export interface ProviderToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function buildProviderToolDeclarations(toolsForRun: Tool[]): ProviderToolDeclaration[] {
  return [...toolsForRun].sort(compareToolName).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: (tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : {}) as unknown as Record<string, unknown>,
  }));
}

export function selectMessagesForModel(params: {
  pendingToolResultFollowUp: boolean;
  currentMessages: Message[];
  prunedMessages: Message[];
  droppedMessages: Message[];
  compactionSummary?: Message;
  promptPruneCompactionSucceeded: boolean;
}): Message[] {
  const shouldAvoidUnsummarizedDrop =
    !params.pendingToolResultFollowUp &&
    params.droppedMessages.length > 0 &&
    !params.compactionSummary &&
    !params.promptPruneCompactionSucceeded;
  const selected = shouldAvoidUnsummarizedDrop
    ? params.currentMessages
    : params.prunedMessages;
  return params.compactionSummary ? [params.compactionSummary, ...selected] : selected;
}

export function summarizeDroppedMessages(messages: Message[]): {
  savedChars: number;
  savedTokens: number;
} {
  return {
    savedChars: Math.max(0, messages.reduce(
      (sum, message) => sum + estimateMessageChars(message),
      0,
    )),
    savedTokens: Math.max(0, messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    )),
  };
}

function compareToolName(a: Tool, b: Tool): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

// ─── Loop control signal ───────────────────────────────────────────

/**
 * Control-flow signal returned by extracted loop phases.
 * - `'continue'`: proceed to the next phase
 * - `'break'`: caller should break out of the inner loop
 * - `'retry'`: caller should `state.turns--; state.compactionRetries++; continue;`
 */
export type LoopControlSignal = 'continue' | 'break' | 'retry';

// ─── Context preparation ───────────────────────────────────────────

export interface PrepareTurnContextResult {
  messagesForModel: Message[];
  toolsForRun: Tool[];
  piContext: PiContext;
  control: LoopControlSignal;
  updatedSnapshots: {
    previousPrefixSnapshot: Message[] | null;
    previousToolNames: string[] | null;
  };
}

export interface PrepareTurnContextParams {
  state: AgentLoopMutableState;
  currentMessages: Message[];
  systemPrompt: string;
  systemPromptParts?: { stable: string; dynamic: string };
  effectiveContextTokens: number;
  charsPerUnit: number;
  modelDef: Model<any>;
  getToolsForRun: () => Tool[];
  sessionKey: string;
  runId: string;
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: (messages?: Message[]) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  abortSignal: AbortSignal;
  pruningSettings?: Partial<ContextPruningSettings>;
  hardCapMessageCount: number;
  hardCapTotalTokens: number;
  previousPrefixSnapshot: Message[] | null;
  previousToolNames: string[] | null;
  prefixDebugEnabled: boolean;
}

/**
 * Prepare the turn context: per-turn context management, proactive compaction,
 * roundtrip repair, pruning, message selection, and provider tool declarations.
 *
 * Returns the data needed for the LLM call plus a control signal.
 * Mutates `state` in place (overflow metrics, compaction flags, etc.).
 */
export async function prepareTurnContext(
  params: PrepareTurnContextParams,
): Promise<PrepareTurnContextResult> {
  const {
    state,
    currentMessages,
    systemPrompt,
    systemPromptParts,
    effectiveContextTokens,
    charsPerUnit,
    modelDef,
    getToolsForRun,
    sessionKey,
    runId,
    prepareCompaction,
    compactHooks,
    persistCurrentMessages,
    push,
    abortSignal,
    pruningSettings,
    hardCapMessageCount,
    hardCapTotalTokens,
  } = params;
  let { previousPrefixSnapshot, previousToolNames } = params;
  const prefixDebugEnabled = params.prefixDebugEnabled;
  const pendingToolResultFollowUp = lastMessageEndsWithToolResult(currentMessages);

  // ===== Per-turn context management =====
  const estPromptTokens = estimatePromptUnitsForContextWindow({
    messages: currentMessages,
    systemPrompt,
    charsPerTokenUnit: charsPerUnit,
    effectiveContextWindowTokens: effectiveContextTokens,
  });
  {
    const ctxMgmt = runPerTurnContextManagement({
      currentMessages,
      estPromptTokens,
      effectiveContextWindowTokens: effectiveContextTokens,
      pendingToolResultFollowUp,
      turns: state.turns,
      push,
    });
    state.overflowState.microcompactTotalSavedChars += ctxMgmt.savedChars;
  }

  // ===== Token estimation for pruning =====
  const promptUnitsForWindow = estimatePromptUnitsForContextWindow({
    messages: currentMessages,
    systemPrompt,
    charsPerTokenUnit: charsPerUnit,
    effectiveContextWindowTokens: effectiveContextTokens,
  });
  const rawTotalChars = estimateMessagesChars(currentMessages) + systemPrompt.length;
  const pruneCharsPerUnit =
    rawTotalChars / effectiveContextTokens >= 0.85 ? 1 : charsPerUnit;
  const systemPromptUnitsForPrune = Math.ceil(
    estimatePromptUnitsForContextWindow({
      messages: [],
      systemPrompt,
      charsPerTokenUnit: pruneCharsPerUnit,
      effectiveContextWindowTokens: effectiveContextTokens,
    }),
  );

  // ===== H1: Hard cap =====
  const hardCapExceeded =
    currentMessages.length >= hardCapMessageCount ||
    (promptUnitsForWindow >= hardCapTotalTokens && !state.promptPruneCompactionSucceeded);

  // ===== Proactive compaction (window economics + hard cap) =====
  if (
    !state.proactiveCompactionAttempted &&
    state.turns >= 2 &&
    !abortSignal.aborted &&
    (hardCapExceeded ||
      (shouldProactiveCompactByWindowEconomics({
        estimatedPromptTokens: promptUnitsForWindow,
        effectiveContextWindowTokens: effectiveContextTokens,
      }) &&
        !pendingToolResultFollowUp &&
        shouldTriggerCompaction({
          messages: currentMessages,
          contextWindowTokens: effectiveContextTokens,
          systemPrompt,
          charsPerTokenUnit: charsPerUnit,
        })))
  ) {
    state.proactiveCompactionAttempted = true;
    if (hardCapExceeded) {
      log.info('hard cap triggered compaction', {
        messageCount: currentMessages.length,
        estimatedPromptTokens: promptUnitsForWindow,
      });
    }
    const compaction = await runProactiveWindowCompaction({
      sessionKey,
      runId,
      currentMessages,
      rawTotalChars,
      promptUnitsForWindow,
      prepareCompaction,
      compactHooks,
      persistCurrentMessages,
      push,
      onWarn: (message, meta) => log.warn(message, meta),
      abortSignal,
    });
    const decision = applyCompactionOutcomeToState(compaction, state);
    if (decision !== 'continue') {
      return emptyResult(decision, previousPrefixSnapshot, previousToolNames);
    }
  }

  // ===== Session roundtrip repair =====
  const sessionRoundtripRepair = repairMissingToolResults(currentMessages);
  if (sessionRoundtripRepair.changed) {
    currentMessages.splice(0, currentMessages.length, ...sessionRoundtripRepair.messages);
    await persistCurrentMessages();
    log.warn('repaired dangling tool_use/tool_result pairs in session before provider call', {
      insertedMissingToolResults: sessionRoundtripRepair.insertedCount,
      synthesizedToolUses: sessionRoundtripRepair.synthesizedToolUseCount,
      orphanResultIds: sessionRoundtripRepair.orphanResultIds,
      runId,
      sessionKey,
      turn: state.turns,
    });
  }

  // ===== Prune =====
  let pruneResult: Pick<PruneResult, 'messages' | 'droppedMessages'> = pendingToolResultFollowUp
    ? { messages: currentMessages, droppedMessages: [] }
    : pruneContextMessages({
        messages: currentMessages,
        contextWindowTokens: effectiveContextTokens,
        systemPromptTokens: systemPromptUnitsForPrune,
        charsPerTokenUnit: pruneCharsPerUnit,
        settings: pruningSettings,
      });
  if (
    !pendingToolResultFollowUp &&
    pruneResult.droppedMessages.length > 0 &&
    !state.promptPruneCompactionAttempted &&
    !abortSignal.aborted
  ) {
    state.promptPruneCompactionAttempted = true;
    const compaction = await runPromptPruneCompaction({
      sessionKey,
      runId,
      currentMessages,
      droppedMessagesForStats: pruneResult.droppedMessages,
      prepareCompaction,
      compactHooks,
      persistCurrentMessages,
      push,
      onWarn: (message, meta) => log.warn(message, meta),
      abortSignal,
    });
    const decision = applyCompactionOutcomeToState(compaction, state);
    if (decision !== 'continue') {
      return emptyResult(decision, previousPrefixSnapshot, previousToolNames);
    }
    // After successful compaction, pruneResult.messages is stale
    if (compaction.succeeded) {
      pruneResult = { messages: currentMessages, droppedMessages: [] };
    }
  }

  // ===== Message selection =====
  let messagesForModel = selectMessagesForModel({
    pendingToolResultFollowUp,
    currentMessages,
    prunedMessages: pruneResult.messages,
    droppedMessages: pruneResult.droppedMessages,
    compactionSummary: state.compactionSummary,
    promptPruneCompactionSucceeded: state.promptPruneCompactionSucceeded,
  });

  const repairedRoundtrip = repairMissingToolResults(messagesForModel);
  if (repairedRoundtrip.changed) {
    messagesForModel = repairedRoundtrip.messages;
    log.warn('repaired dangling tool_use/tool_result pairs in provider window', {
      insertedMissingToolResults: repairedRoundtrip.insertedCount,
      synthesizedToolUses: repairedRoundtrip.synthesizedToolUseCount,
      orphanResultIds: repairedRoundtrip.orphanResultIds,
      runId,
      sessionKey,
      turn: state.turns,
    });
  }

  // ===== Prefix debug: prompt stability =====
  if (prefixDebugEnabled) {
    const issue = checkPromptPrefixStable(previousPrefixSnapshot, messagesForModel);
    if (issue) {
      log.warn('prompt prefix changed before provider call', {
        sessionKey,
        runId,
        turn: state.turns,
        ...issue,
      });
    }
    previousPrefixSnapshot = snapshotMessagesForPrefixCheck(messagesForModel);
  }

  // ===== Provider tool declarations =====
  const toolsForRun = getToolsForRun();
  const toolFollowupNeedsThinkingHistory =
    shouldSuppressReasoningForToolFollowUpRound(messagesForModel) &&
    hasAssistantThinkingHistory(messagesForModel);
  const modelDefForMessageConversion = toolFollowupNeedsThinkingHistory
    ? ({ ...(modelDef as object), reasoning: true } as typeof modelDef)
    : modelDef;
  const piMessages = convertMessagesToPi(messagesForModel, modelDefForMessageConversion);
  const piTools = buildProviderToolDeclarations(toolsForRun);

  // ===== Prefix debug: tool order =====
  if (prefixDebugEnabled) {
    const currentToolNames = piTools.map((t) => t.name);
    const toolOrderCheck = checkToolOrderConsistency(previousToolNames, currentToolNames);
    if (!toolOrderCheck.consistent) {
      log.warn('tool order changed between turns (causes prompt cache miss)', {
        sessionKey,
        runId,
        turn: state.turns,
        detail: toolOrderCheck.detail,
      });
    }
    previousToolNames = currentToolNames;
  }

  // pi-ai Context requires typebox TSchema for tools; cast at the boundary
  const piContext = {
    systemPrompt,
    messages: piMessages,
    ...(piTools.length > 0 ? { tools: piTools } : {}),
    ...(systemPromptParts ? { systemPromptParts } : {}),
  } as PiContext;

  return {
    messagesForModel,
    toolsForRun,
    piContext,
    control: 'continue',
    updatedSnapshots: { previousPrefixSnapshot, previousToolNames },
  };
}

// ─── Internal helpers ──────────────────────────────────────────────

function lastMessageEndsWithToolResult(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const c = last.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
  );
}

function emptyResult(
  control: LoopControlSignal,
  previousPrefixSnapshot: Message[] | null,
  previousToolNames: string[] | null,
): PrepareTurnContextResult {
  return {
    messagesForModel: [],
    toolsForRun: [],
    piContext: { systemPrompt: '', messages: [] } as PiContext,
    control,
    updatedSnapshots: { previousPrefixSnapshot, previousToolNames },
  };
}

/**
 * Apply compaction outcome to mutable state. Returns the control signal
 * the caller should act on.
 *
 * - `'retry'`: caller should `state.compactionRetries++; state.turns--; continue;`
 * - `'break'`: caller should break out of the inner loop
 * - `'continue'`: caller should fall through
 */
function applyCompactionOutcomeToState(
  compaction: AgentLoopCompactionOutcome,
  state: AgentLoopMutableState,
): LoopControlSignal {
  if (compaction.succeeded) {
    state.overflowState.contextCompactions++;
    state.compactionSummary = compaction.compactionSummary;
    state.promptPruneCompactionSucceeded = true;
  }
  if (compaction.retrySameTurn) {
    if (state.compactionRetries >= 2) return 'break';
    return 'retry';
  }
  return 'continue';
}
