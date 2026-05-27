/**
 * LLM call execution — wraps `runAgentLoopLlmTurn` with tracing,
 * usage recording, and context-overflow recovery.
 *
 * Extracted from the inner loop of `runAgentLoop` to isolate the
 * LLM-call-with-retry concern from the surrounding control flow.
 */

import type {
  Context as PiContext,
  Model,
  StopReason,
  StreamFunction,
  ThinkingLevel,
} from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool } from '../tools/tool-types.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import type { CompactHookRegistry } from './compact-hooks.js';
import {
  isContextOverflowError,
  describeError,
} from '../../provider/errors.js';
import {
  withSpan,
  turnAttributes,
} from '../../observability/tracing.js';
import { redactSensitiveData } from '../../observability/redact.js';
import {
  runAgentLoopLlmTurn,
} from './agent-loop-stream-helpers.js';
import {
  runOverflowRecovery,
} from './overflow-recovery.js';
import type { LoopControlSignal } from './agent-loop-context-prep.js';

export interface ExecuteLlmTurnParams {
  state: AgentLoopMutableState;
  modelDef: Model<any>;
  piContext: PiContext;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  reasoning?: ThinkingLevel;
  topP?: number;
  abortSignal: AbortSignal;
  messagesForModel: Message[];
  toolsForRun: Tool[];
  sessionKey: string;
  runId: string;
  runStartMs: number;
  push: (event: MiniAgentEvent) => void;
  currentMessages: Message[];
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
  replaceMessages?: (sessionKey: string, messages: Message[]) => Promise<void>;
  compactHooks?: CompactHookRegistry;
  recordLlmUsage: (record: {
    runId: string;
    providerId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }) => Promise<void>;
  lastMessageNeedsToolFollowUpLlm: (messages: Message[]) => boolean;
}

export interface ExecuteLlmTurnResult {
  control: LoopControlSignal;
  assistantContent: ContentBlock[];
  messageThinkingChunks: string[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  turnTextParts: string[];
  streamStopReason: StopReason | undefined;
}

function emptyResult(control: LoopControlSignal): ExecuteLlmTurnResult {
  return {
    control,
    assistantContent: [],
    messageThinkingChunks: [],
    toolCalls: [],
    turnTextParts: [],
    streamStopReason: undefined,
  };
}

/**
 * Execute one LLM turn with tracing, usage recording, and overflow recovery.
 *
 * On context-overflow errors, attempts recovery via `runOverflowRecovery`.
 * If recovery succeeds with `'retry-same-turn'`, returns `control: 'retry'`
 * so the caller can `state.turns--; continue;`.
 *
 * On any other error, rethrows.
 */
export async function executeLlmTurn(
  params: ExecuteLlmTurnParams,
): Promise<ExecuteLlmTurnResult> {
  const {
    state,
    modelDef,
    piContext,
    streamFn,
    apiKey,
    temperature,
    reasoning,
    topP,
    abortSignal,
    messagesForModel,
    toolsForRun,
    sessionKey,
    runId,
    runStartMs,
    push,
    currentMessages,
    prepareCompaction,
    replaceMessages,
    compactHooks,
    recordLlmUsage,
    lastMessageNeedsToolFollowUpLlm,
  } = params;

  const llmTurnStartedAt = Date.now();

  try {
    const llmTurn = await withSpan(
      'agent.llm_turn',
      turnAttributes(runId, state.turns, String(modelDef.id)),
      async (span) => {
        span.addEvent('prompt_window', {
          messages: messagesForModel.length,
          tools: toolsForRun.length,
        });
        const turn = await runAgentLoopLlmTurn({
          stream: { push },
          modelDef,
          piContext,
          streamFn,
          apiKey,
          temperature,
          reasoning,
          topP,
          abortSignal,
          messagesForModel,
          toolsForRun,
          sessionKey,
          turn: state.turns,
          runStartMs,
          firstTokenMs: state.firstTokenMs,
          logDebug: () => {},
        });
        if (turn.usage) {
          span.setAttribute('inputTokens', turn.usage.inputTokens);
          span.setAttribute('outputTokens', turn.usage.outputTokens);
          span.addEvent('usage', {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens,
          });
        }
        return turn;
      },
    );

    state.firstTokenMs = llmTurn.firstTokenMs;
    if (llmTurn.usage) {
      push({
        type: 'llm_usage',
        inputTokens: llmTurn.usage.inputTokens,
        outputTokens: llmTurn.usage.outputTokens,
      });
      await recordLlmUsage({
        runId,
        providerId: String(modelDef.provider),
        model: String(modelDef.id),
        inputTokens: llmTurn.usage.inputTokens,
        outputTokens: llmTurn.usage.outputTokens,
        durationMs: Date.now() - llmTurnStartedAt,
        success: true,
      });
    }

    return {
      control: 'continue',
      assistantContent: llmTurn.assistantContent,
      messageThinkingChunks: llmTurn.messageThinkingChunks,
      toolCalls: llmTurn.toolCalls,
      turnTextParts: llmTurn.turnTextParts,
      streamStopReason: llmTurn.streamStopReason,
    };
  } catch (llmError) {
    await recordLlmUsage({
      runId,
      providerId: String(modelDef.provider),
      model: String(modelDef.id),
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - llmTurnStartedAt,
      success: false,
      error: String(redactSensitiveData(describeError(llmError))),
    });
    const errorText = describeError(llmError);
    if (
      isContextOverflowError(errorText) &&
      state.overflowState.level < 3 &&
      !lastMessageNeedsToolFollowUpLlm(currentMessages)
    ) {
      const outcome = await runOverflowRecovery({
        state: state.overflowState,
        errorText,
        currentMessages,
        sessionKey,
        runId,
        prepareCompaction,
        compactHooks,
        push,
        replaceMessages,
        abortSignal,
      });
      if (outcome.kind === 'retry-same-turn') {
        if (outcome.replacedSummaryMessage) {
          state.compactionSummary = outcome.replacedSummaryMessage;
        }
        return emptyResult('retry');
      }
    }
    throw llmError;
  }
}
