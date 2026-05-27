/**
 * Post-LLM response processing — analyses the LLM output, decides the next
 * action, and executes tool calls when appropriate.
 *
 * Extracted from the inner loop of `runAgentLoop` (L658-904) to isolate
 * the response-handling concern from the surrounding control flow.
 */

import type { StopReason } from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool, ToolContext } from '../tools/tool-types.js';
import type { ToolHookRegistry } from '../tools/tool-hooks.js';
import type { AgentLoopMutableState } from './agent-loop-state.js';
import type { ToolLoopGuardState } from '../tools/tool-loop-guard.js';
import type { LoopControlSignal } from './agent-loop-context-prep.js';
import {
  injectToolCallFromPlanText,
  normalizeAssistantToolCalls,
  isThinkingOnlyAssistantTurn,
  buildThinkingOnlyUserHint,
  buildVisibleAssistantText,
  extractThinkingTextFromMessage,
  shouldNudgeMissingToolInvocation,
} from './agent-loop-assistant-turn.js';
import { shouldSuppressReasoningForToolFollowUpRound } from './follow-up-guard.js';
import { buildNamedWebToolMatcher } from '../../prompts/plan-detection.js';
import {
  decidePostLlmAction,
  type PostLlmAction,
} from './agent-loop-post-llm.js';
import {
  executeAgentLoopToolCalls,
  type AgentLoopToolExecutionMetrics,
} from './agent-loop-tool-execution.js';

export interface ProcessLlmResponseParams {
  state: AgentLoopMutableState;
  assistantContent: ContentBlock[];
  messageThinkingChunks: string[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  turnTextParts: string[];
  streamStopReason: StopReason | undefined;
  maxTurns: number;
  maxOutputContinuations: number;
  abortSignal: AbortSignal;
  isQuiet: boolean;
  sessionKey: string;
  currentMessages: Message[];
  /** Shared assistant buffer — processLlmResponse pushes here; caller persists in finally. */
  assistantBuffer: Message[];
  resolveToolsForRun: () => Tool[];
  toolCtx: ToolContext;
  toolHooks?: ToolHookRegistry;
  toolTimeoutMs: number;
  toolHeartbeatIntervalMs: number;
  skipHeartbeatToolNames: Set<string>;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  getSteeringMessages: () => Promise<Message[]>;
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
  buildCorrectionMessage: (systemText: string) => Message;
}

export interface ProcessLlmResponseResult {
  control: LoopControlSignal;
}

/**
 * Process the LLM response: analyse assistant output, decide next action,
 * and execute tool calls when appropriate.
 *
 * Returns a control signal:
 * - `'continue'`: the inner loop should continue (next iteration)
 * - `'break'`: not currently used; reserved for future exits
 *
 * Mutates `assistantBuffer` in place (pushes assistant messages for the caller
 * to flush via its try/finally). The callee NEVER replaces the buffer identity —
 * only mutates its contents. (C2: eliminates dangling-reference bugs.)
 *
 * For the `tool_execute` path, the buffer is flushed inline before tool execution
 * to maintain correct message ordering (assistant with tool_use must precede
 * user with tool_result).
 *
 * Mutates `state` in place (hasMoreToolCalls, finalText, counters, etc.).
 */
export async function processLlmResponse(
  params: ProcessLlmResponseParams,
): Promise<ProcessLlmResponseResult> {
  const {
    state,
    assistantContent,
    messageThinkingChunks,
    toolCalls,
    turnTextParts,
    streamStopReason,
    maxTurns,
    maxOutputContinuations,
    abortSignal,
    isQuiet,
    sessionKey,
    currentMessages,
    assistantBuffer,
    resolveToolsForRun,
    toolCtx,
    toolHooks,
    toolTimeoutMs,
    toolHeartbeatIntervalMs,
    skipHeartbeatToolNames,
    parallelSafeTools,
    loadToolsMetaName,
    toolLoopGuard,
    checkToolApproval,
    toolAbortSignalFor,
    enrichToolContext,
    getSteeringMessages,
    appendMessage,
    push,
    buildCorrectionMessage,
  } = params;

  // ===== Inject tool calls from plan text =====
  const toolsForAssistantTurn = resolveToolsForRun();
  injectToolCallFromPlanText({
    toolCalls,
    assistantContent,
    turnTextParts,
    messageThinkingChunks,
    toolsForRun: toolsForAssistantTurn,
    sessionKey,
    logInfo: !isQuiet
      ? undefined // caller can provide via params if needed
      : undefined,
  });

  // ===== Normalize tool calls =====
  if (toolCalls.length > 0) {
    normalizeAssistantToolCalls({
      toolCalls,
      assistantContent,
      toolsForRun: toolsForAssistantTurn,
      sessionKey,
    });
  }

  // ===== Build visible text and thinking fallback =====
  const turnText = turnTextParts.join('');
  const turnTrim = turnText.trim();
  const thinkingFallback = turnTrim
    ? ''
    : extractThinkingTextFromMessage(messageThinkingChunks, assistantContent);

  const hasThinkingOnly = isThinkingOnlyAssistantTurn({
    visibleText: turnText,
    toolCallCount: toolCalls.length,
    thinkingChunks: messageThinkingChunks,
    assistantContent,
  });

  // ===== Pre-persistence: thinking-only retry =====
  if (
    hasThinkingOnly &&
    state.toolExecutionMetrics.totalToolCalls > 0 &&
    state.postToolThinkingOnlyRetryAttempts < 1 &&
    state.turns < maxTurns &&
    !abortSignal.aborted
  ) {
    state.postToolThinkingOnlyRetryAttempts += 1;
    state.pendingMessages = [buildCorrectionMessage(
      '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
      'Read the latest tool results and produce a concise visible user-facing summary now. ' +
      'Do not call more tools unless absolutely necessary.',
    )];
    push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
    state.lastTurnEndMs = Date.now();
    return { control: 'continue' };
  }

  // ===== Thinking-only hint =====
  if (hasThinkingOnly) {
    const hint = buildThinkingOnlyUserHint(state.toolExecutionMetrics.totalToolCalls);
    push({ type: 'message_delta', delta: hint });
    turnTextParts.push(hint);
  }

  // ===== Build assistant message =====
  const assistantMsg: Message = {
    role: 'assistant',
    content: assistantContent,
    timestamp: Date.now(),
    ...(messageThinkingChunks.length > 0 ? { thinking: [...messageThinkingChunks] } : {}),
  };

  // Buffer assistant message into the shared buffer — flushed by caller's try/finally
  if (!hasThinkingOnly) {
    assistantBuffer.push(assistantMsg);
  }

  const visibleAssistantText = buildVisibleAssistantText({
    textParts: turnTextParts,
    thinkingFallback,
  });
  push({ type: 'message_end', message: assistantMsg, text: visibleAssistantText });

  // ===== Update state =====
  state.hasMoreToolCalls = toolCalls.length > 0;
  if (!state.hasMoreToolCalls) {
    state.finalText = visibleAssistantText;
  }

  // ===== Nudge predicate =====
  const toolsForNudge = resolveToolsForRun();
  const namedWebToolRe = buildNamedWebToolMatcher(toolsForNudge.map((x) => x.name));
  const shouldNudge =
    !state.hasMoreToolCalls &&
    shouldNudgeMissingToolInvocation({
      finalText: state.finalText,
      messageThinkingChunks,
      assistantContent,
      namedWebToolRe,
    });

  // ===== Fetch steering (for non-tool paths) =====
  const cachedSteering = toolCalls.length === 0
    ? await getSteeringMessages()
    : [];

  // ===== Decide action =====
  const postLlmAction = decidePostLlmAction({
    hasThinkingOnly,
    toolCallCount: toolCalls.length,
    postToolThinkingOnlyRetryAttempts: state.postToolThinkingOnlyRetryAttempts,
    totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
    streamStopReason,
    outputContinuationCount: state.outputContinuationCount,
    maxOutputContinuations,
    planToolNudgeAttempts: state.planToolNudgeAttempts,
    finalText: state.finalText,
    maxTurns,
    turns: state.turns,
    shouldNudge,
    hasSteeringMessages: cachedSteering.length > 0,
    abortAborted: abortSignal.aborted,
  });

  // ===== Execute action =====
  switch (postLlmAction.kind) {
    case 'thinking_retry':
      // Already handled above (pre-persistence); unreachable here.
      break;

    case 'thinking_only_hint':
      push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
      state.lastTurnEndMs = Date.now();
      state.pendingMessages = cachedSteering;
      return { control: 'continue' };

    case 'continuation':
      state.outputContinuationCount++;
      push({
        type: 'output_continuation',
        attempt: state.outputContinuationCount,
        maxAttempts: maxOutputContinuations,
      });
      state.pendingMessages = [buildCorrectionMessage(postLlmAction.systemText)];
      push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'nudge':
      state.planToolNudgeAttempts += 1;
      push({ type: 'message_delta', delta: postLlmAction.deltaText });
      state.pendingMessages = [buildCorrectionMessage(postLlmAction.systemText)];
      push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'empty_retry':
      state.pendingMessages = cachedSteering.length > 0
        ? cachedSteering
        : [buildCorrectionMessage(
            "[System] Your previous response was empty. Please answer the user's question again.",
          )];
      push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
      state.lastTurnEndMs = Date.now();
      return { control: 'continue' };

    case 'steering_or_complete':
      push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
      state.lastTurnEndMs = Date.now();
      state.pendingMessages = cachedSteering;
      return { control: 'continue' };

    case 'tool_execute':
      // Fall through to tool execution below.
      break;
  }

  // ===== Execute tools =====
  // Flush assistant buffer before tool execution to maintain correct message order:
  // assistant (with tool_use) must appear before user (with tool_result) in currentMessages.
  // C1: Shift-based — removes each message AFTER successful append so partial failure
  // leaves only unflushed messages (no duplicates when caller's finally re-flushes).
  while (assistantBuffer.length > 0) {
    const msg = assistantBuffer[0]!;
    await appendMessage(sessionKey, msg);
    currentMessages.push(msg);
    assistantBuffer.shift();
  }
  const toolExecution = await executeAgentLoopToolCalls({
    sessionKey,
    currentMessages,
    assistantContent,
    toolCalls,
    resolveToolsForRun,
    toolCtx,
    toolHooks,
    abortSignal,
    toolTimeoutMs,
    toolHeartbeatIntervalMs,
    skipHeartbeatToolNames,
    checkToolApproval,
    toolAbortSignalFor,
    enrichToolContext,
    parallelSafeTools,
    loadToolsMetaName,
    toolLoopGuard,
    metrics: state.toolExecutionMetrics,
    getSteeringMessages,
    appendMessage,
    push,
  });

  push({ type: 'turn_end', turn: state.turns, totalToolCalls: state.toolExecutionMetrics.totalToolCalls });
  state.lastTurnEndMs = Date.now();
  state.pendingMessages = toolExecution.pendingMessages;

  return { control: 'continue' };
}
