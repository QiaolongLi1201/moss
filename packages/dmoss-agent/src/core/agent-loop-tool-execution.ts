import { truncateToolOutput } from '../context/tool-output-truncate.js';
import { getRootLogger } from '../logger.js';
import type { LLMMessage } from './llm-provider.js';
import type { MiniAgentEvent } from './agent-events.js';
import {
  executeOneToolCall,
  outcomeToResult,
  type ExecuteToolCallOutcome,
} from './execute-tool-call.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from './open-url-web-fetch-guard.js';
import { notePendingAbortedToolCalls } from './pending-tool-aborts.js';
import type { Message, ContentBlock } from './session-jsonl.js';
import type { Tool, ToolContext } from './tool-types.js';
import type { ToolHookRegistry } from './tool-hooks.js';
import { findReplayableToolResultContent } from './tool-idempotent-replay.js';
import {
  formatToolResultForSsePreview,
  groupToolCallsForExecution,
  skipToolCall,
  syncAssistantToolUseInput,
} from './agent-loop-tool-helpers.js';
import {
  formatToolLoopGuardMessage,
  shouldShortCircuitToolCall,
  type ToolLoopGuardState,
} from './tool-loop-guard.js';

const log = getRootLogger().child('agent:loop');

export interface AgentLoopToolExecutionMetrics {
  totalToolCalls: number;
  toolErrors: number;
  toolCallsByName: Record<string, number>;
  prepNextTurnParallelMs: number;
}

export interface ExecuteAgentLoopToolCallsParams {
  sessionKey: string;
  currentMessages: Message[];
  assistantContent: ContentBlock[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  resolveToolsForRun: () => Tool[];
  toolCtx: ToolContext;
  toolHooks?: ToolHookRegistry;
  abortSignal: AbortSignal;
  toolTimeoutMs: number;
  toolHeartbeatIntervalMs: number;
  skipHeartbeatToolNames: Set<string>;
  checkToolApproval?: (call: {
    id: string;
    name: string;
    input: unknown;
  }) => Promise<{ approved: boolean; decision: string } | null>;
  toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
  enrichToolContext?: (baseCtx: ToolContext, sessionKey: string) => ToolContext;
  parallelSafeTools: Set<string>;
  loadToolsMetaName?: string;
  toolLoopGuard: ToolLoopGuardState;
  metrics: AgentLoopToolExecutionMetrics;
  getSteeringMessages: () => Promise<Message[]>;
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  push: (event: MiniAgentEvent) => void;
}

export async function executeAgentLoopToolCalls(
  params: ExecuteAgentLoopToolCallsParams,
): Promise<{ pendingMessages: Message[] }> {
  const {
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
    metrics,
    getSteeringMessages,
    appendMessage,
    push,
  } = params;

  const toolResults: ContentBlock[] = [];
  let steeringMessages: Message[] | null = null;
  const historyBeforeAssistant = currentMessages.slice(0, -1) as unknown as LLMMessage[];

  const preflightToolCall = (
    call: { id: string; name: string; input: Record<string, unknown> },
  ): ExecuteToolCallOutcome | null => {
    const loopReason = shouldShortCircuitToolCall(toolLoopGuard, call.name, call.input);
    if (loopReason) {
      log.warn('tool loop guard short-circuited tool call', {
        tool: call.name,
        reason: loopReason,
        sessionKey,
      });
      return {
        kind: 'pre-blocked',
        text: formatToolLoopGuardMessage(loopReason, call.name),
      };
    }

    const fetchSuppressed =
      call.name === 'web_fetch'
        ? maybeSuppressRedundantWebFetchAfterOpenUrl(
            historyBeforeAssistant,
            String((call.input as Record<string, unknown>)?.url ?? ''),
          )
        : null;
    if (fetchSuppressed) {
      log.info('web_fetch suppressed (open_url already opened the page)', {
        url: (call.input as Record<string, unknown>)?.url,
      });
      return {
        kind: 'completed',
        text: fetchSuppressed,
        isError: false,
        durationMs: 0,
      };
    }

    const replayed = findReplayableToolResultContent(
      historyBeforeAssistant,
      call.name,
      call.input,
      6,
    );
    if (replayed) {
      log.info('tool replay: reusing recent identical-params result', {
        tool: call.name,
      });
      return {
        kind: 'completed',
        text: replayed,
        isError: false,
        durationMs: 0,
      };
    }

    return null;
  };

  const recordToolOutcome = (
    call: { id: string; name: string; input: Record<string, unknown> },
    outcome: ExecuteToolCallOutcome,
  ): void => {
    syncAssistantToolUseInput(assistantContent, call);
    if (outcome.kind !== 'completed') {
      push({
        type: 'tool_execution_start',
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });
    }

    const { text: result, isError } = outcomeToResult(outcome);
    metrics.totalToolCalls++;
    metrics.toolCallsByName[call.name] = (metrics.toolCallsByName[call.name] ?? 0) + 1;
    if (isError) metrics.toolErrors++;

    const truncatedResult = truncateToolOutput(call.name, result);
    const preview =
      outcome.kind === 'hook-blocked' || outcome.kind === 'denied'
        ? truncatedResult
        : formatToolResultForSsePreview(truncatedResult, isError);

    push({
      type: 'tool_execution_end',
      toolCallId: call.id,
      toolName: call.name,
      result: preview,
      isError,
      content: truncatedResult,
      ...(outcome.kind === 'completed' && outcome.aborted
        ? { aborted: outcome.aborted }
        : {}),
    });
    toolResults.push({
      type: 'tool_result',
      tool_use_id: call.id,
      name: call.name,
      content: truncatedResult,
      is_error: isError,
    });
  };

  const skipRemainingToolCalls = (
    calls: { id: string; name: string }[],
  ): void => {
    for (const skipped of calls) {
      push({
        type: 'tool_skipped',
        toolCallId: skipped.id,
        toolName: skipped.name,
      });
      toolResults.push(skipToolCall(skipped));
    }
  };

  const effectiveParallelSafeTools = checkToolApproval
    ? new Set<string>()
    : parallelSafeTools;
  const toolGroups = groupToolCallsForExecution(
    toolCalls,
    effectiveParallelSafeTools,
    loadToolsMetaName,
  );

  for (const group of toolGroups) {
    const toolsForRun = resolveToolsForRun();
    if (steeringMessages) {
      skipRemainingToolCalls(group.calls);
      continue;
    }

    if (group.parallel && group.calls.length > 1) {
      const settled = await Promise.allSettled(
        group.calls.map((call) => {
          const execCall = {
            id: call.id,
            name: call.name,
            input: { ...call.input },
          };
          const preflight = preflightToolCall(execCall);
          if (preflight) return Promise.resolve(preflight);
          return executeOneToolCall(execCall, {
            toolsForRun,
            toolCtx,
            sessionKey,
            toolHooks,
            abortSignal,
            toolTimeoutMs,
            enableHeartbeat: true,
            heartbeatIntervalMs: toolHeartbeatIntervalMs,
            skipHeartbeatToolNames,
            checkToolApproval: undefined,
            toolAbortSignalFor,
            enrichToolContext,
            push,
            onBeforeStartEmit: (input) => {
              execCall.input = input;
              syncAssistantToolUseInput(assistantContent, execCall);
            },
          }).then((outcome) => {
            call.input = execCall.input;
            return outcome;
          });
        }),
      );
      for (let j = 0; j < group.calls.length; j++) {
        const call = group.calls[j];
        const s = settled[j];
        const outcome: ExecuteToolCallOutcome =
          s.status === 'fulfilled'
            ? s.value
            : {
                kind: 'pre-blocked',
                text: `Execution error: ${String((s as PromiseRejectedResult).reason)}`,
              };
        recordToolOutcome(call, outcome);
      }
      const steering = await getSteeringMessages();
      if (steering.length > 0) {
        steeringMessages = steering;
        push({ type: 'steering', pendingCount: steering.length });
      }
    } else {
      for (let gi = 0; gi < group.calls.length; gi++) {
        const call = group.calls[gi];
        const preflight = preflightToolCall(call);
        if (preflight) {
          recordToolOutcome(call, preflight);
          continue;
        }

        const outcome = await executeOneToolCall(call, {
          toolsForRun: resolveToolsForRun(),
          toolCtx,
          sessionKey,
          toolHooks,
          abortSignal,
          toolTimeoutMs,
          enableHeartbeat: true,
          heartbeatIntervalMs: toolHeartbeatIntervalMs,
          skipHeartbeatToolNames,
          checkToolApproval,
          toolAbortSignalFor,
          enrichToolContext,
          push,
          onBeforeStartEmit: (input) => {
            syncAssistantToolUseInput(assistantContent, { ...call, input });
          },
        });

        if (outcome.kind === 'hook-blocked') {
          recordToolOutcome(call, outcome);
          const steering = await getSteeringMessages();
          if (steering.length > 0) {
            steeringMessages = steering;
          }
          if (steeringMessages) break;
          continue;
        }

        if (outcome.kind === 'denied') {
          recordToolOutcome(call, outcome);
          const steering = await getSteeringMessages();
          if (steering.length > 0) {
            steeringMessages = steering;
            skipRemainingToolCalls(group.calls.slice(gi + 1));
            push({ type: 'steering', pendingCount: steering.length });
          }
          if (steeringMessages) break;
          continue;
        }

        recordToolOutcome(call, outcome);

        const steering = await getSteeringMessages();
        if (steering.length > 0) {
          steeringMessages = steering;
          skipRemainingToolCalls(group.calls.slice(gi + 1));
          push({ type: 'steering', pendingCount: steering.length });
          break;
        }
      }
    }
  }

  const resultMsg: Message = {
    role: 'user',
    content: toolResults,
    timestamp: Date.now(),
  };
  currentMessages.push(resultMsg);

  let toolResultMsgPersisted = false;
  let newSteering: Message[] = [];
  try {
    const parallelStartMs = Date.now();
    const steeringPromise =
      steeringMessages && steeringMessages.length > 0
        ? Promise.resolve(steeringMessages)
        : getSteeringMessages();
    const [, steering] = await Promise.all([
      appendMessage(sessionKey, resultMsg),
      steeringPromise,
    ]);
    newSteering = steering;
    toolResultMsgPersisted = true;
    metrics.prepNextTurnParallelMs += Date.now() - parallelStartMs;
  } finally {
    if (abortSignal.aborted && !toolResultMsgPersisted) {
      notePendingAbortedToolCalls(
        sessionKey,
        toolCalls.map((c) => ({ id: c.id, name: c.name })),
      );
    }
  }

  return {
    pendingMessages: steeringMessages && steeringMessages.length > 0
      ? steeringMessages
      : newSteering,
  };
}
