/** Core agent loop: orchestrates context prep, LLM turns, tool execution and follow-ups. */

import type { EventStream } from '@mariozechner/pi-ai';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:loop');
import type { Message, ContentBlock } from './session-jsonl.js';
import type {
  Context as PiContext,
  StopReason,
} from '@mariozechner/pi-ai';
import {
  isContextOverflowError,
  describeError,
} from '../provider/errors.js';
import {
  ensureKeepAliveDispatcherInstalled,
  wasConnectionReused,
} from '../provider/keep-alive-dispatcher.js';
import { resolveToolFollowupBypassCap } from '../utils/max-agent-turns.js';
import {
  pruneContextMessages,
  type PruneResult,
} from '../context/pruning.js';
import {
  estimatePromptUnitsForContextWindow,
  resolveContextCharsPerTokenUnit,
  estimateMessagesChars,
} from '../context/tokens.js';
import {
  createMiniAgentStream,
  type MiniAgentEvent,
  type MiniAgentResult,
} from './agent-events.js';
import { runPerTurnContextManagement } from './per-turn-context-management.js';
import {
  createOverflowRecoveryState,
  runOverflowRecovery,
} from './overflow-recovery.js';
import {
  bumpAgentLoopRunEpoch,
  guardMiniAgentStreamPush,
} from './agent-loop-push-guard.js';
import {
  consumePendingAbortedToolSyntheticMessages,
} from './pending-tool-aborts.js';
import { convertMessagesToPi } from './message-convert.js';
import {
  buildThinkingOnlyUserHint,
  buildVisibleAssistantText,
  extractThinkingTextFromMessage,
  hasAssistantThinkingHistory,
  injectToolCallFromPlanText,
  isThinkingOnlyAssistantTurn,
  normalizeAssistantToolCalls,
  shouldNudgeMissingToolInvocation,
} from './agent-loop-assistant-turn.js';
import { shouldSuppressReasoningForToolFollowUpRound } from './follow-up-guard.js';
import { repairMissingToolResults } from './tool-result-roundtrip-guard.js';
import {
  getEffectiveContextWindowTokens,
  shouldProactiveCompactByWindowEconomics,
} from '../context/window-economics.js';
import { shouldTriggerCompaction } from '../context/compaction.js';
import {
  buildProviderToolDeclarations,
  selectMessagesForModel,
} from './agent-loop-context-prep.js';
import {
  createToolLoopGuardState,
} from './tool-loop-guard.js';
import { buildNamedWebToolMatcher } from '../prompts/plan-detection.js';
import {
  checkPromptPrefixStable,
  checkToolOrderConsistency,
  isPromptPrefixDebugEnabled,
  snapshotMessagesForPrefixCheck,
} from './prompt-prefix-cache.js';
import {
  classifyLlmError,
  retryDelayForLlmError,
} from './llm-error-classifier.js';
import {
  runAgentLoopLlmTurn,
} from './agent-loop-stream-helpers.js';
import {
  runProactiveWindowCompaction,
  runPromptPruneCompaction,
} from './agent-loop-compaction.js';
import {
  executeAgentLoopToolCalls,
  type AgentLoopToolExecutionMetrics,
} from './agent-loop-tool-execution.js';
import type { AgentLoopParams } from './agent-loop-types.js';
export type { AgentLoopParams, AgentLoopPlatformConfig } from './agent-loop-types.js';

// ============== 平台可配置项 ==============

const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS = 30_000;

/** 上下文末尾是否为「刚写入的工具结果」user 消息，尚缺一次模型调用来读结果并回复用户 */
export function lastMessageNeedsToolFollowUpLlm(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const c = last.content;
  if (!Array.isArray(c)) return false;
  return c.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result',
  );
}

// ============== 主循环 ==============

export function runAgentLoop(
  params: AgentLoopParams,
): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();

  // 进程级 keepAlive 连接池 idempotent 安装。
  // fire-and-forget：async installer 不阻塞首轮 LLM；二次调用 no-op。
  void ensureKeepAliveDispatcherInstalled();

  (async () => {
    const {
      runId,
      sessionKey,
      currentMessages,
      systemPrompt,
      systemPromptParts,
      getToolsForRun,
      toolCtx,
      modelDef,
      streamFn,
      apiKey,
      temperature,
      topP,
      reasoning,
      maxTurns,
      contextTokens,
      getSteeringMessages,
      getFollowUpMessages,
      appendMessage,
      prepareCompaction,
      abortSignal,
      maxOutputTokens: maxOutputTokensParam,
      pruningSettings,
      compactHooks,
      systemPromptMeta,
      platform,
    } = params;

    const persistCurrentMessages = async (): Promise<void> => {
      if (params.replaceMessages) {
        await params.replaceMessages(sessionKey, currentMessages);
      }
    };

    const runEpoch = bumpAgentLoopRunEpoch(sessionKey);
    guardMiniAgentStreamPush(stream, sessionKey, runEpoch);

    const parallelSafeTools = platform?.parallelSafeTools ?? new Set<string>();
    const toolTimeoutMs = platform?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const toolHeartbeatIntervalMs =
      platform?.toolHeartbeatIntervalMs ?? DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS;
    const skipHeartbeatToolNames = platform?.skipHeartbeatToolNames ?? new Set<string>();
    const loadToolsMetaName = platform?.loadToolsMetaName;

    let { compactionSummary } = params;
    let turns = 0;
    let postLimitToolFollowUpsUsed = 0;
    const toolFollowupBypassCap = resolveToolFollowupBypassCap(maxTurns);
    let finalText = '';
    /** Aggregated overflow-recovery / cheap-mitigation state (see overflow-recovery.ts). */
    const overflowState = createOverflowRecoveryState();
    const prefixDebugEnabled = isPromptPrefixDebugEnabled();
    let previousPrefixSnapshot: Message[] | null = null;
    let previousToolNames: string[] | null = null;

    const MAX_OUTPUT_CONTINUATIONS = 3;
    let outputContinuationCount = 0;
    /** 每轮 run 最多自动纠偏一次「只写计划不调工具」，避免在顽固模型上耗满 maxTurns */
    let planToolNudgeAttempts = 0;
    /** 工具已经执行后，若模型只吐 reasoning、不吐可见总结，最多额外追问一次。 */
    let postToolThinkingOnlyRetryAttempts = 0;

    const runStartMs = Date.now();
    let firstTokenMs: number | null = null;
    const toolExecutionMetrics: AgentLoopToolExecutionMetrics = {
      totalToolCalls: 0,
      toolErrors: 0,
      toolCallsByName: {},
      prepNextTurnParallelMs: 0,
    };

    // Inter-turn latency + parallel savings observability.
    const interTurnSilenceMs: number[] = [];
    let lastTurnEndMs: number | null = null;
    const toolLoopGuard = createToolLoopGuardState();

    try {
      for (const syn of consumePendingAbortedToolSyntheticMessages(sessionKey)) {
        await appendMessage(sessionKey, syn);
        currentMessages.push(syn);
      }

      const charsPerUnit = resolveContextCharsPerTokenUnit();
      let pendingMessages = await getSteeringMessages();

      // ========== 外层循环 (follow-ups) ==========
      outerLoop: while (true) {
        let proactiveCompactionAttempted = false;
        let promptPruneCompactionAttempted = false;
        let promptPruneCompactionSucceeded = false;
        let hasMoreToolCalls = true;

        // ========== 内层循环 (tools + steering) ==========
        while (hasMoreToolCalls || pendingMessages.length > 0) {
          if (turns >= maxTurns) {
            const needsToolFollow = lastMessageNeedsToolFollowUpLlm(currentMessages);
            if (needsToolFollow && postLimitToolFollowUpsUsed < toolFollowupBypassCap) {
              postLimitToolFollowUpsUsed += 1;
            } else {
              stream.push({
                type: 'turn_transition',
                turn: turns,
                reason: needsToolFollow ? 'tool_followup_cap_reached' : 'max_turns_reached',
              });
              break outerLoop;
            }
          }
          if (abortSignal.aborted) {
            stream.push({ type: 'turn_transition', turn: turns, reason: 'aborted_by_user' });
            break outerLoop;
          }

          turns++;
          // Sample inter-turn latency (null on first turn).
          if (lastTurnEndMs !== null) {
            interTurnSilenceMs.push(Date.now() - lastTurnEndMs);
          }
          stream.push({ type: 'turn_start', turn: turns });

          let toolsForRun = getToolsForRun ? getToolsForRun() : params.toolsForRun;

          const deferPendingUntilToolFollowUpCompletes = lastMessageNeedsToolFollowUpLlm(currentMessages);
          if (pendingMessages.length > 0 && !deferPendingUntilToolFollowUpCompletes) {
            for (const msg of pendingMessages) {
              await appendMessage(sessionKey, msg);
              currentMessages.push(msg);
            }
            pendingMessages = [];
          }

          const maxOut = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
          const effectiveContextTokens = getEffectiveContextWindowTokens(contextTokens, maxOut);
          const estPromptTokens = estimatePromptUnitsForContextWindow({
            messages: currentMessages,
            systemPrompt,
            charsPerTokenUnit: charsPerUnit,
            effectiveContextWindowTokens: effectiveContextTokens,
          });
          const pendingToolResultFollowUp = lastMessageNeedsToolFollowUpLlm(currentMessages);

          // ===== 失效旧读取 + 尾段超长截断 + 自适应 MicroCompact =====
          {
            const ctxMgmt = runPerTurnContextManagement({
              currentMessages,
              estPromptTokens,
              effectiveContextWindowTokens: effectiveContextTokens,
              pendingToolResultFollowUp,
              turns,
              push: (e) => stream.push(e),
            });
            overflowState.microcompactTotalSavedChars += ctxMgmt.savedChars;
          }

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

          // ===== 主动压缩（窗口经济学） =====
          if (
            !proactiveCompactionAttempted &&
            turns >= 2 &&
            !abortSignal.aborted &&
            shouldProactiveCompactByWindowEconomics({
              estimatedPromptTokens: promptUnitsForWindow,
              effectiveContextWindowTokens: effectiveContextTokens,
            }) &&
            !pendingToolResultFollowUp &&
            shouldTriggerCompaction({
              messages: currentMessages,
              contextWindowTokens: effectiveContextTokens,
              systemPrompt,
              charsPerTokenUnit: charsPerUnit,
            })
          ) {
            proactiveCompactionAttempted = true;
            const compaction = await runProactiveWindowCompaction({
              sessionKey,
              runId,
              currentMessages,
              rawTotalChars,
              promptUnitsForWindow,
              prepareCompaction,
              compactHooks,
              persistCurrentMessages,
              push: (event) => stream.push(event),
              onWarn: (message, meta) => log.warn(message, meta),
            });
            if (compaction.succeeded) {
              compactionSummary = compaction.compactionSummary;
              promptPruneCompactionSucceeded = true;
              overflowState.contextCompactions++;
            }
            if (compaction.retrySameTurn) {
              turns--;
              continue;
            }
          }

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
              turn: turns,
            });
          }

          // ===== Prune =====
          const pruneResult: Pick<PruneResult, 'messages' | 'droppedMessages'> = pendingToolResultFollowUp
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
            !promptPruneCompactionAttempted &&
            !abortSignal.aborted
          ) {
            promptPruneCompactionAttempted = true;
            const compaction = await runPromptPruneCompaction({
              sessionKey,
              runId,
              currentMessages,
              droppedMessagesForStats: pruneResult.droppedMessages,
              prepareCompaction,
              compactHooks,
              persistCurrentMessages,
              push: (event) => stream.push(event),
              onWarn: (message, meta) => log.warn(message, meta),
            });
            if (compaction.succeeded) {
              compactionSummary = compaction.compactionSummary;
              promptPruneCompactionSucceeded = true;
              overflowState.contextCompactions++;
            }
            if (compaction.retrySameTurn) {
              turns--;
              continue;
            }
          }
          let messagesForModel = selectMessagesForModel({
            pendingToolResultFollowUp,
            currentMessages,
            prunedMessages: pruneResult.messages,
            droppedMessages: pruneResult.droppedMessages,
            compactionSummary,
            promptPruneCompactionSucceeded,
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
              turn: turns,
            });
          }

          if (prefixDebugEnabled) {
            const issue = checkPromptPrefixStable(previousPrefixSnapshot, messagesForModel);
            if (issue) {
              log.warn('prompt prefix changed before provider call', {
                sessionKey,
                runId,
                turn: turns,
                ...issue,
              });
            }
            previousPrefixSnapshot = snapshotMessagesForPrefixCheck(messagesForModel);
          }

          const toolFollowupNeedsThinkingHistory =
            shouldSuppressReasoningForToolFollowUpRound(messagesForModel) &&
            hasAssistantThinkingHistory(messagesForModel);
          const modelDefForMessageConversion = toolFollowupNeedsThinkingHistory
            ? ({ ...(modelDef as object), reasoning: true } as typeof modelDef)
            : modelDef;
          const piMessages = convertMessagesToPi(messagesForModel, modelDefForMessageConversion);
          // pi-ai SDK types use typebox TSchema; our Tool uses plain JSON Schema objects.
          // This boundary cast is unavoidable without a typebox dependency.
          // Keep provider-facing tool declarations sorted for prompt prefix caching.
          const piTools = buildProviderToolDeclarations(toolsForRun);

          if (prefixDebugEnabled) {
            const currentToolNames = piTools.map((t) => t.name);
            const toolOrderCheck = checkToolOrderConsistency(previousToolNames, currentToolNames);
            if (!toolOrderCheck.consistent) {
              log.warn('tool order changed between turns (causes prompt cache miss)', {
                sessionKey,
                runId,
                turn: turns,
                detail: toolOrderCheck.detail,
              });
            }
            previousToolNames = currentToolNames;
          }

          // pi-ai Context requires typebox TSchema for tools; cast the tools array at the boundary
          const piContext = {
            systemPrompt,
            messages: piMessages,
            ...(piTools.length > 0 ? { tools: piTools } : {}),
            ...(systemPromptParts && modelDef.api === 'anthropic-messages'
              ? { systemPromptParts }
              : {}),
          } as PiContext;

          // ===== 带重试的 LLM 调用 =====
          let assistantContent: ContentBlock[];
          let messageThinkingChunks: string[];
          let toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
          let turnTextParts: string[];
          let streamStopReason: StopReason | undefined;

          try {
            const llmTurn = await runAgentLoopLlmTurn({
              stream,
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
              turn: turns,
              runStartMs,
              firstTokenMs,
              logDebug: (message, meta) => log.debug(message, meta),
            });
            assistantContent = llmTurn.assistantContent;
            messageThinkingChunks = llmTurn.messageThinkingChunks;
            toolCalls = llmTurn.toolCalls;
            turnTextParts = llmTurn.turnTextParts;
            streamStopReason = llmTurn.streamStopReason;
            firstTokenMs = llmTurn.firstTokenMs;
          } catch (llmError) {
            const errorText = describeError(llmError);
            if (
              isContextOverflowError(errorText) &&
              overflowState.level < 3 &&
              !lastMessageNeedsToolFollowUpLlm(currentMessages)
            ) {
              const outcome = await runOverflowRecovery({
                state: overflowState,
                errorText,
                currentMessages,
                sessionKey,
                runId,
                prepareCompaction,
                compactHooks,
                push: (e) => stream.push(e),
                replaceMessages: params.replaceMessages,
              });
              if (outcome.kind === 'retry-same-turn') {
                if (outcome.replacedSummaryMessage) {
                  compactionSummary = outcome.replacedSummaryMessage;
                }
                turns--;
                continue;
              }
            }
            throw llmError;
          }

          const toolsForAssistantTurn = getToolsForRun ? getToolsForRun() : params.toolsForRun;
          injectToolCallFromPlanText({
            toolCalls,
            assistantContent,
            turnTextParts,
            messageThinkingChunks,
            toolsForRun: toolsForAssistantTurn,
            sessionKey,
            logInfo:
              process.env.DMOSS_QUIET !== 'true'
                ? (message, meta) => log.info(message, meta)
                : undefined,
          });

          if (toolCalls.length > 0) {
            normalizeAssistantToolCalls({
              toolCalls,
              assistantContent,
              toolsForRun: toolsForAssistantTurn,
              sessionKey,
            });
          }

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
          if (
            hasThinkingOnly &&
            toolExecutionMetrics.totalToolCalls > 0 &&
            postToolThinkingOnlyRetryAttempts < 1 &&
            turns < maxTurns &&
            !abortSignal.aborted
          ) {
            postToolThinkingOnlyRetryAttempts += 1;
            pendingMessages = [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      '[System] The tools already ran, but your previous assistant turn had no visible answer. ' +
                      'Read the latest tool results and produce a concise visible user-facing summary now. ' +
                      'Do not call more tools unless absolutely necessary.',
                  },
                ],
                timestamp: Date.now(),
              },
            ];
            if (process.env.DMOSS_QUIET !== 'true') {
              log.warn('retrying post-tool thinking-only assistant turn for visible summary', {
                thinkingChunks: messageThinkingChunks.length,
                stopReason: streamStopReason,
                totalToolCalls: toolExecutionMetrics.totalToolCalls,
                sessionKey,
              });
            }
            stream.push({ type: 'turn_end', turn: turns });
            lastTurnEndMs = Date.now();
            continue;
          }
          if (hasThinkingOnly) {
            const hint = buildThinkingOnlyUserHint(toolExecutionMetrics.totalToolCalls);
            stream.push({ type: 'message_delta', delta: hint });
            turnTextParts.push(hint);
            if (process.env.DMOSS_QUIET !== 'true') {
              log.warn('skipping persistence for thinking-only assistant turn (agent-loop bridge)', {
                thinkingChunks: messageThinkingChunks.length,
                stopReason: streamStopReason,
                sessionKey,
              });
            }
          }

          // 保存 assistant 消息。推理-only 回合只作为本轮事件展示，不写入下轮上下文。
          const assistantMsg: Message = {
            role: 'assistant',
            content: assistantContent,
            timestamp: Date.now(),
            ...(messageThinkingChunks.length > 0 ? { thinking: [...messageThinkingChunks] } : {}),
          };
          if (!hasThinkingOnly) {
            await appendMessage(sessionKey, assistantMsg);
            currentMessages.push(assistantMsg);
          }

          const visibleAssistantText = buildVisibleAssistantText({
            textParts: turnTextParts,
            thinkingFallback,
          });
          stream.push({ type: 'message_end', message: assistantMsg, text: visibleAssistantText });

          // max_tokens 截断续写
          if (
            streamStopReason === 'length' &&
            toolCalls.length === 0 &&
            outputContinuationCount < MAX_OUTPUT_CONTINUATIONS &&
            !abortSignal.aborted
          ) {
            const steer = await getSteeringMessages();
            if (steer.length === 0) {
              outputContinuationCount++;
              stream.push({
                type: 'output_continuation',
                attempt: outputContinuationCount,
                maxAttempts: MAX_OUTPUT_CONTINUATIONS,
              });
              pendingMessages = [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: '[System] Your previous response was truncated due to max_tokens. Continue from where you left off without repeating already-output content.',
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              stream.push({ type: 'turn_end', turn: turns });
              lastTurnEndMs = Date.now();
              continue;
            }
          }

          hasMoreToolCalls = toolCalls.length > 0;

          if (!hasMoreToolCalls) {
            finalText = visibleAssistantText;
            const toolsForNudge = getToolsForRun ? getToolsForRun() : params.toolsForRun;
            const namedWebToolRe = buildNamedWebToolMatcher(toolsForNudge.map((x) => x.name));
            if (
              planToolNudgeAttempts < 1 &&
              turns < maxTurns &&
              shouldNudgeMissingToolInvocation({
                finalText,
                messageThinkingChunks,
                assistantContent,
                namedWebToolRe,
              })
            ) {
              planToolNudgeAttempts += 1;
              stream.push({
                type: 'message_delta',
                delta:
                  '\n\n> （系统）检测到仅说明了工具与链接但未发起实际工具调用，已自动追加一轮对话以执行操作。\n',
              });
              pendingMessages = [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text:
                        '[System] You described using tools or opening a URL in plain text but did not emit any function/tool calls. ' +
                        'You MUST invoke the appropriate tool now with valid JSON arguments for that URL/intent. ' +
                        'Do not repeat the plan—call the tool immediately.',
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              stream.push({ type: 'turn_end', turn: turns });
              lastTurnEndMs = Date.now();
              continue;
            }
            if (!finalText.trim() && turns < maxTurns - 1) {
              pendingMessages = await getSteeringMessages();
              if (pendingMessages.length === 0) {
                pendingMessages = [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: "[System] Your previous response was empty. Please answer the user's question again.",
                      },
                    ],
                    timestamp: Date.now(),
                  },
                ];
              }
              continue;
            }
            stream.push({ type: 'turn_end', turn: turns });
            lastTurnEndMs = Date.now();
            pendingMessages = await getSteeringMessages();
            continue;
          }

          // ===== 执行工具 =====
          const toolExecution = await executeAgentLoopToolCalls({
            sessionKey,
            currentMessages,
            assistantContent,
            toolCalls,
            resolveToolsForRun: () => (getToolsForRun ? getToolsForRun() : params.toolsForRun),
            toolCtx,
            toolHooks: params.toolHooks,
            abortSignal,
            toolTimeoutMs,
            toolHeartbeatIntervalMs,
            skipHeartbeatToolNames,
            checkToolApproval: params.checkToolApproval,
            toolAbortSignalFor: params.toolAbortSignalFor,
            enrichToolContext: params.enrichToolContext,
            parallelSafeTools,
            loadToolsMetaName,
            toolLoopGuard,
            metrics: toolExecutionMetrics,
            getSteeringMessages,
            appendMessage,
            push: (e) => stream.push(e),
          });

          stream.push({ type: 'turn_end', turn: turns });
          lastTurnEndMs = Date.now();
          pendingMessages = toolExecution.pendingMessages;
        }
        // ========== 内层循环结束 ==========

        if (getFollowUpMessages) {
          const followUp = await getFollowUpMessages();
          if (followUp.length > 0) {
            pendingMessages = followUp;
            continue;
          }
        }
        break;
      }
      // ========== 外层循环结束 ==========

      const maxOutMetrics = maxOutputTokensParam ?? modelDef.maxTokens ?? 8192;
      const effMetrics = getEffectiveContextWindowTokens(contextTokens, maxOutMetrics);
      stream.push({
        type: 'run_metrics',
        metrics: {
          runId,
          sessionKey,
          totalTurns: turns,
          totalToolCalls: toolExecutionMetrics.totalToolCalls,
          toolCallsByName: toolExecutionMetrics.toolCallsByName,
          toolErrors: toolExecutionMetrics.toolErrors,
          microcompactSavedChars: overflowState.microcompactTotalSavedChars,
          overflowRecoveries: overflowState.overflowRecoveries,
          totalDurationMs: Date.now() - runStartMs,
          firstTokenMs,
          contextCompactions: overflowState.contextCompactions,
          systemPromptChars: systemPrompt.length,
          systemPromptHashShort: systemPromptMeta?.hashShort ?? '',
          effectiveContextTokens: effMetrics,
          llmCompactionFailureStreak: overflowState.llmCompactionFailureStreak,
          systemPromptLayerCount: systemPromptMeta?.layerCount ?? 0,
          // Observability for inter-turn latency.
          interTurnSilenceMs,
          llmConnectionReused: wasConnectionReused(),
          prepNextTurnParallelMs: toolExecutionMetrics.prepNextTurnParallelMs,
        },
      });

      stream.push({ type: 'agent_end', runId, messages: currentMessages });
      stream.end({ finalText, turns, totalToolCalls: toolExecutionMetrics.totalToolCalls, messages: currentMessages });
    } catch (err) {
      stream.push({ type: 'agent_error', runId, error: describeError(err) });
      stream.end({ finalText, turns, totalToolCalls: toolExecutionMetrics.totalToolCalls, messages: currentMessages });
    }
  })();

  return stream;
}
