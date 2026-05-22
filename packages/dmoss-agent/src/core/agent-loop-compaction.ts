import { estimateMessageChars, estimateMessageTokens } from '../context/tokens.js';
import { describeError } from '../provider/errors.js';
import type { MiniAgentEvent } from './agent-events.js';
import {
  buildCompactionCheckpointOutline,
  type CompactHookRegistry,
} from './compact-hooks.js';
import type { Message } from './session-jsonl.js';
import { summarizeDroppedMessages } from './agent-loop-context-prep.js';

export interface AgentLoopPrepareCompaction {
  (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
    forceCompaction?: boolean;
  }): Promise<{
    summary?: string;
    summaryMessage?: Message;
    messages?: Message[];
    droppedMessages?: number;
    checkpointOutline?: string[];
  }>;
}

export interface AgentLoopCompactionOutcome {
  attempted: boolean;
  succeeded: boolean;
  retrySameTurn: boolean;
  compactionSummary?: Message;
}

export async function runProactiveWindowCompaction(params: {
  sessionKey: string;
  runId: string;
  currentMessages: Message[];
  rawTotalChars: number;
  promptUnitsForWindow: number;
  prepareCompaction: AgentLoopPrepareCompaction;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: () => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
}): Promise<AgentLoopCompactionOutcome> {
  const {
    sessionKey,
    runId,
    currentMessages,
    rawTotalChars,
    promptUnitsForWindow,
    prepareCompaction,
    compactHooks,
    persistCurrentMessages,
    push,
    onWarn,
  } = params;
  try {
    await compactHooks?.runPreHooks({
      sessionKey,
      runId,
      messages: currentMessages,
      reason: 'proactive',
    });
    const prep = await prepareCompaction({
      messages: currentMessages,
      sessionKey,
      runId,
    });
    const checkpointOutline =
      prep.checkpointOutline ?? buildCompactionCheckpointOutline(prep.summary);
    const droppedMessages = Math.max(0, Number(prep.droppedMessages ?? 0));
    await compactHooks?.runPostHooks({
      sessionKey,
      runId,
      summaryChars: prep.summary?.length ?? 0,
      droppedMessages,
      reason: 'proactive',
      success: Boolean(prep.summary && prep.summaryMessage),
      ...(checkpointOutline ? { checkpointOutline } : {}),
    });
    if (!prep.summary || !prep.summaryMessage) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    push({
      type: 'compaction',
      summaryChars: prep.summary.length,
      droppedMessages,
      ...(checkpointOutline ? { checkpointOutline } : {}),
    });
    let compactionSummary: Message | undefined = prep.summaryMessage;
    if (prep.messages?.length) {
      currentMessages.splice(0, currentMessages.length, ...prep.messages);
      await persistCurrentMessages();
      compactionSummary = undefined;
    }
    const summaryChars = estimateMessageChars(prep.summaryMessage);
    const summaryTokens = estimateMessageTokens(prep.summaryMessage);
    const savedChars = Math.max(0, rawTotalChars - summaryChars);
    const savedTokens = Math.max(0, Math.round(promptUnitsForWindow - summaryTokens));
    push({
      type: 'context_action',
      reason: 'proactive_threshold',
      actions: [
        {
          kind: 'llm_summarize',
          reason: 'proactive_threshold',
          count: 1,
          savedChars,
          savedTokens,
        },
      ],
      savedChars,
      savedTokens,
    });
    return {
      attempted: true,
      succeeded: true,
      retrySameTurn: true,
      compactionSummary,
    };
  } catch (error) {
    onWarn?.('proactive compaction failed', { error: describeError(error) });
    return { attempted: true, succeeded: false, retrySameTurn: false };
  }
}

export async function runPromptPruneCompaction(params: {
  sessionKey: string;
  runId: string;
  currentMessages: Message[];
  droppedMessagesForStats: Message[];
  prepareCompaction: AgentLoopPrepareCompaction;
  compactHooks?: CompactHookRegistry;
  persistCurrentMessages: () => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
}): Promise<AgentLoopCompactionOutcome> {
  const {
    sessionKey,
    runId,
    currentMessages,
    droppedMessagesForStats,
    prepareCompaction,
    compactHooks,
    persistCurrentMessages,
    push,
    onWarn,
  } = params;
  try {
    await compactHooks?.runPreHooks({
      sessionKey,
      runId,
      messages: currentMessages,
      reason: 'proactive',
    });
    const prep = await prepareCompaction({
      messages: currentMessages,
      sessionKey,
      runId,
      forceCompaction: true,
    });
    const checkpointOutline =
      prep.checkpointOutline ?? buildCompactionCheckpointOutline(prep.summary);
    const droppedMessages = Math.max(
      0,
      Number(prep.droppedMessages ?? droppedMessagesForStats.length),
    );
    await compactHooks?.runPostHooks({
      sessionKey,
      runId,
      summaryChars: prep.summary?.length ?? 0,
      droppedMessages,
      reason: 'proactive',
      success: Boolean(prep.summary && prep.summaryMessage),
      ...(checkpointOutline ? { checkpointOutline } : {}),
    });
    if (!prep.summary || !prep.summaryMessage) {
      return { attempted: true, succeeded: false, retrySameTurn: false };
    }

    const droppedStats = summarizeDroppedMessages(droppedMessagesForStats);
    push({
      type: 'compaction',
      summaryChars: prep.summary.length,
      droppedMessages,
      ...(checkpointOutline ? { checkpointOutline } : {}),
    });
    let compactionSummary: Message | undefined = prep.summaryMessage;
    if (prep.messages?.length) {
      currentMessages.splice(0, currentMessages.length, ...prep.messages);
      await persistCurrentMessages();
      compactionSummary = undefined;
    }
    push({
      type: 'context_action',
      reason: 'proactive_threshold',
      actions: [
        {
          kind: 'llm_summarize',
          reason: 'proactive_threshold',
          count: 1,
          savedChars: droppedStats.savedChars,
          savedTokens: droppedStats.savedTokens,
        },
      ],
      savedChars: droppedStats.savedChars,
      savedTokens: droppedStats.savedTokens,
    });
    return {
      attempted: true,
      succeeded: true,
      retrySameTurn: true,
      compactionSummary,
    };
  } catch (error) {
    onWarn?.('prompt prune compaction failed; sending full context to provider', {
      error: describeError(error),
    });
    return { attempted: true, succeeded: false, retrySameTurn: false };
  }
}
