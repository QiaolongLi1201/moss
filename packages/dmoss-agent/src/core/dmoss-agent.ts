/**
 * DmossAgent — the central orchestrator that ties together all D-Moss modules.
 *
 * This is the primary entry point for creating a D-Moss agent instance.
 * Host applications create a DmossAgent and configure it
 * with their LLM provider, session store, tools, and platform extensions.
 *
 * Enhanced capabilities (v2):
 *  - Pruning: three-layer context pruning (soft trim → hard clear → message drop)
 *  - Compaction: LLM-based context summarization when pruning alone isn't enough
 *  - Thinking stream: inline `<thinking>` tag routing for reasoning display
 *  - Follow-up tool handling: detects pending tool results & unexecuted intents
 *  - Steering: rule-based conversation guidance injection
 */

import type {
  LLMProvider,
  LLMMessage,
  LLMContentBlock,
  LLMResponse,
  LLMStreamEvent,
} from './llm-provider.js';
import type { Message } from './session-jsonl.js';
import type { SessionStore } from './session.js';
import type { Tool, ToolContext, ToolCall, ToolResult } from './tool-types.js';
import { canHostInjectToolWithEmptyInput } from './tool-types.js';
import { extractToolInvocationFromPlanText } from './extract-tool-invocation.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent');
import { ToolRegistry } from './tool-registry.js';
import type { AgentHooks } from './agent-hooks.js';
import {
  registerKnowledgeModule,
  findModuleForPlatform,
  getAllPromptFragments,
  getAggregatedEcosystemPrompt,
} from '../knowledge/registry.js';
import { buildRoboticsEngineeringPrompt } from '@dmoss/core/prompts/robotics';
import type { KnowledgeModule } from '@dmoss/core/contracts/knowledge-module';
import { truncateToolOutput } from '../context/tool-output-truncate.js';
import { combineAbortSignals, abortable } from './abort.js';
import {
  pruneContextMessages,
  type ContextPruningSettings,
  type PruneResult,
} from '../context/pruning.js';
import {
  shouldTriggerCompaction,
  shouldProactiveCompact,
  compactHistoryIfNeeded,
  type CompactionSettings,
  type SummarizeFn,
} from '../context/compaction.js';
import { createRemoteCompactProviderFromEnv } from '../context/remote-compaction.js';
import { microcompact, type MicroCompactConfig } from '../context/microcompact.js';
import {
  snipTailOversizedToolResults,
  type TailToolSnipConfig,
} from '../context/tail-tool-snip.js';
import { invalidateStaleReadToolResults } from '../context/stale-read-invalidate.js';
import {
  estimateMessagesTokens,
  estimateMessagesChars,
  estimatePromptUnitsForContextWindow,
  resolveContextCharsPerTokenUnit,
} from '../context/tokens.js';
import {
  getEffectiveContextWindowTokens,
  shouldProactiveCompactByWindowEconomics,
} from '../context/window-economics.js';
import {
  retryAsync,
  isTransientError,
  isContextOverflowError,
  describeError,
} from '../provider/errors.js';
import {
  resolveDmossMaxAgentTurns,
  resolveToolFollowupBypassCap,
} from '../utils/max-agent-turns.js';
import {
  createInlineThinkingRouter,
  splitThinkingTagsFromAssistantText,
  stripThinkingTagsKeepVisible,
} from './inline-thinking-stream.js';
import { SteeringEngine, type SteeringRule, DEFAULT_STEERING_RULES } from './steering.js';
import {
  lastMessageNeedsToolFollowUp,
  shouldSuppressReasoningForToolFollowUpRound,
  detectUnexecutedToolIntents,
  extractThinkingTagBodies,
  type FollowUpGuardConfig,
  DEFAULT_FOLLOW_UP_GUARD_CONFIG,
} from './follow-up-guard.js';
import {
  buildCompactionCheckpointOutline,
  type CompactHookRegistry,
  type CompactReason,
} from './compact-hooks.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from './open-url-web-fetch-guard.js';
import { findReplayableToolResultContent } from './tool-idempotent-replay.js';
import {
  createToolLoopGuardState,
  formatToolLoopGuardMessage,
  shouldShortCircuitToolCall,
  type ToolLoopGuardState,
} from './tool-loop-guard.js';
import { repairMissingToolResults } from './tool-result-roundtrip-guard.js';
import { validateToolInputObject } from './tool-pipeline.js';
import {
  buildTaskFrameContext,
  createOrUpdateTaskFrame,
  createTaskFrameCheckpointMessage,
  detectContinuationIntent,
  recordTaskFrameAssistant,
  recordTaskFrameCompaction,
  recordTaskFrameStop,
  recordTaskFrameToolEnd,
  recordTaskFrameToolStart,
  splitTaskFrameCheckpointMessages,
  stripTaskFrameCheckpointsFromLlmMessages,
  type TaskFrame,
} from './task-frame.js';
import { runAgentLoop } from './agent-loop.js';
import type { SkillLearner } from './skill-learner.js';
import {
  createDmossAgentLoopEventAdapter,
  createModelDefFromDmossConfig,
} from './dmoss-agent-loop-adapter.js';
import { createStreamFunctionFromLlmProvider } from './llm-provider-stream-adapter.js';
import type { ThinkingLevel } from '@mariozechner/pi-ai';
import {
  extractVisibleAssistantText as extractVisibleAssistantTextCore,
  normalizeToolInput as normalizeToolInputCore,
  normalizeToolUseBlocksInContent as normalizeToolUseBlocksInContentCore,
  buildFollowUpGuardMessages as buildFollowUpGuardMessagesCore,
  tryInjectHostToolUseFromIntent as tryInjectHostToolUseFromIntentCore,
  executeToolBlock as executeToolBlockCore,
  executeToolBlockWithHistory as executeToolBlockWithHistoryCore,
  type ToolUseBlockWithType,
} from './dmoss-agent-tool-helpers.js';
import {
  applyPreLlmContextOptimizations as applyPreLlmContextOptimizationsCore,
  runPruning as runPruningCore,
  runCompactionIfNeeded as runCompactionIfNeededCore,
  shouldCompact as shouldCompactCore,
} from './dmoss-agent-context-helpers.js';
import { evaluateSteering as evaluateSteeringCore } from './dmoss-agent-steering-helpers.js';
import type {
  DmossAgentConfig as SharedDmossAgentConfig,
  ChatOptions as SharedChatOptions,
  ChatResult as SharedChatResult,
  DmossAgentEvent as SharedDmossAgentEvent,
  InternalMessage as SharedInternalMessage,
  InternalContentBlock as SharedInternalContentBlock,
} from './dmoss-agent-types.js';
import {
  toSessionMessages as sharedToSessionMessages,
  fromSessionMessages as sharedFromSessionMessages,
  toLLMMessages as sharedToLLMMessages,
} from './dmoss-agent-types.js';

// ─── Configuration ──────────────────────────────────────────────

export type DmossAgentConfig = SharedDmossAgentConfig;
export type ChatOptions = SharedChatOptions;
export type ChatResult = SharedChatResult;
export type DmossAgentEvent = SharedDmossAgentEvent;
export type InternalMessage = SharedInternalMessage;
export type InternalContentBlock = SharedInternalContentBlock;
const toSessionMessages = sharedToSessionMessages;
const fromSessionMessages = sharedFromSessionMessages;
const toLLMMessages = sharedToLLMMessages;

// ─── Agent ──────────────────────────────────────────────────────

export class DmossAgent {
  readonly tools: ToolRegistry;
  readonly config: DmossAgentConfig;

  private steeringEngine: SteeringEngine | null = null;

  /** Server-side compaction when `DMOSS_REMOTE_COMPACT_ENDPOINT` is set (hybrid + local fallback). */
  private readonly remoteCompactProvider = createRemoteCompactProviderFromEnv();

  constructor(config: DmossAgentConfig) {
    this.config = config;
    this.tools = new ToolRegistry();

    if (config.enableSteering !== false) {
      const rules = config.replaceDefaultSteeringRules
        ? (config.steeringRules ?? [])
        : [...DEFAULT_STEERING_RULES, ...(config.steeringRules ?? [])];
      this.steeringEngine = new SteeringEngine(rules);
    }
  }

  private extractVisibleAssistantText(content: LLMContentBlock[]): string {
    return extractVisibleAssistantTextCore(content);
  }

  private normalizeToolInput(
    toolName: string,
    input: Record<string, unknown>,
    allTools: Tool[],
    ctx: Pick<ToolContext, 'sessionKey' | 'sessionId'>,
  ): Record<string, unknown> {
    return normalizeToolInputCore(toolName, input, allTools, ctx, log);
  }

  private normalizeToolUseBlocksInContent(
    content: LLMContentBlock[],
    allTools: Tool[],
    ctx: Pick<ToolContext, 'sessionKey' | 'sessionId'>,
  ): void {
    normalizeToolUseBlocksInContentCore(content, allTools, ctx, log);
  }

  private buildFollowUpGuardMessages(messages: InternalMessage[]): LLMMessage[] {
    return buildFollowUpGuardMessagesCore(messages);
  }

  /**
   * 上游未返回 `tool_use` 但跟进规则命中工具意图时，尽最大努力把该工具**真的调起来**。
   *
   * 三档策略（从强到弱）：
   *   1. **参数从文本抽取**：用 `extractToolInvocationFromPlanText` 在可见正文 + thinking
   *      中按 JSON Schema 解析 URL / number / boolean / string 参数；只要 required 全部命中就注入
   *      完整的 `tool_use`（包含真实参数），**无需等模型二次 `tool_calls`**。这是解决 doubao / qwen
   *      等在 thinking 里写完整规划但被 stream error 截断的关键路径。
   *   2. **空参注入**：对 `canHostInjectToolWithEmptyInput` 的工具（无 required 字段）用 `{}` 注入。
   *   3. **跳过**：required 参数缺失时不盲注，退回 nudge 让模型再试（旧行为保留）。
   *
   * 设计理由（来自用户反馈）：
   *   - 这是**框架能力**，不应该靠模型"多次尝试"或 prompt 调教；
   *   - 只要模型在规划里说了要调用的工具和参数，Agent 就应当直接调起来，直到任务完成。
   */
  private async tryInjectHostToolUseFromIntent(
    messages: InternalMessage[],
    sessionKey: string,
    store: SessionStore,
    allTools: Tool[],
    followUpConfig: Partial<FollowUpGuardConfig>,
  ): Promise<ToolUseBlockWithType | null> {
    return tryInjectHostToolUseFromIntentCore({
      config: this.config,
      messages,
      sessionKey,
      store,
      allTools,
      followUpConfig,
      log,
    });
  }

  /** Register a knowledge module */
  registerKnowledge(module: KnowledgeModule): void {
    registerKnowledgeModule(module);
  }

  /** Build the system prompt for a given platform context */
  buildSystemPrompt(options?: { platform?: string; extraContext?: string }): string {
    const parts: string[] = [];

    if (this.config.baseSystemPrompt) {
      parts.push(this.config.baseSystemPrompt);
    }

    if (this.config.domainPrompt === false) {
      // host explicitly opted out of built-in domain prompt
    } else if (typeof this.config.domainPrompt === 'function') {
      parts.push(this.config.domainPrompt());
    } else {
      parts.push(buildRoboticsEngineeringPrompt());
    }

    const ecosystem = getAggregatedEcosystemPrompt();
    if (ecosystem) parts.push(ecosystem);

    if (this.config.includeRegisteredKnowledgePrompts !== false) {
      const fragments = getAllPromptFragments({ tier: 'all', mode: 'all' });
      if (fragments.length > 0) {
        parts.push(fragments.map((f) => f.content).join('\n\n'));
      }
    }

    if (options?.platform) {
      const mod = findModuleForPlatform(options.platform);
      if (mod) {
        const profiles = mod.getDeviceProfiles();
        const profile = profiles[options.platform];
        if (profile) {
          parts.push(
            `## Connected Device: ${profile.displayName}\n- SoC: ${profile.soc}\n- Compute: ${profile.computeTops} TOPS (${profile.computeUnit})\n- RAM: ${profile.ramGb} GB`,
          );
        }
      }
    }

    if (this.config.extraPromptLayers) {
      parts.push(...this.config.extraPromptLayers);
    }

    if (options?.extraContext) {
      parts.push(options.extraContext);
    }

    return parts.filter(Boolean).join('\n\n');
  }

  // ─── Context optimization pipeline ────────────────────────────

  /**
   * Apply all zero-cost context optimizations to the message array.
   * Called before each LLM request to keep token usage lean.
   *
   * Pipeline order (cheapest first):
   *  1. Stale-read invalidation
   *  2. Microcompact (old tool_result → placeholder)
   *  3. Tail-tool-snip (near-tail oversized results)
   */
  private applyPreLlmContextOptimizations(messages: InternalMessage[]): {
    messages: InternalMessage[];
    events: DmossAgentEvent[];
  } {
    const result = applyPreLlmContextOptimizationsCore(messages, this.config);
    const events: DmossAgentEvent[] = result.events.map((evt) => ({
      type: 'microcompact',
      compressedCount: evt.compressedCount,
      savedChars: evt.savedChars,
      savedTokens: evt.savedTokens,
    }));
    return { messages: result.messages, events };
  }

  /**
   * Run pruning (three-layer) on messages. Returns a PruneResult.
   */
  private runPruning(
    messages: InternalMessage[],
    contextWindowTokens: number,
    systemPrompt: string,
  ): PruneResult {
    return runPruningCore(messages, contextWindowTokens, systemPrompt, this.config);
  }

  /**
   * Run LLM-based compaction if the context window is under pressure.
   * Returns the compacted messages or the original messages if compaction was not needed.
   */
  private async runCompactionIfNeeded(
    messages: InternalMessage[],
    contextWindowTokens: number,
    _sessionKey: string,
    _runId: string,
    systemPrompt: string,
    options?: { forceCompaction?: boolean },
  ): Promise<{
    messages: InternalMessage[];
    compacted: boolean;
    summaryChars: number;
    droppedMessages: number;
    checkpointOutline?: string[];
  }> {
    return runCompactionIfNeededCore(
      messages,
      contextWindowTokens,
      systemPrompt,
      this.config.llmProvider,
      this.remoteCompactProvider,
      this.config,
      options,
    );
  }

  /**
   * Check whether compaction should be triggered (reactive or proactive).
   */
  private shouldCompact(
    messages: InternalMessage[],
    contextWindowTokens: number,
    systemPrompt: string,
  ): boolean {
    return shouldCompactCore(messages, contextWindowTokens, systemPrompt, this.config);
  }

  // ─── Tool execution ───────────────────────────────────────────

  private async executeToolBlock(
    block: { id: string; name: string; input: Record<string, unknown> },
    allTools: Tool[],
    sessionKey: string,
    options?: ChatOptions,
  ): Promise<{ resultContent: string; isError: boolean; aborted?: { by: 'user' | 'timeout' } }> {
    return executeToolBlockCore(block, allTools, sessionKey, this.config, {
      abortSignal: options?.abortSignal,
      toolAbortSignalFor: options?.toolAbortSignalFor,
      log,
    });
  }

  private async executeToolBlockWithHistory(
    block: { id: string; name: string; input: Record<string, unknown> },
    historyBeforeAssistant: LLMMessage[],
    allTools: Tool[],
    sessionKey: string,
    toolLoopGuard: ToolLoopGuardState,
    options?: ChatOptions,
  ): Promise<{ resultContent: string; isError: boolean; aborted?: { by: 'user' | 'timeout' } }> {
    return executeToolBlockWithHistoryCore(block, historyBeforeAssistant, allTools, sessionKey, toolLoopGuard, this.config, {
      abortSignal: options?.abortSignal,
      toolAbortSignalFor: options?.toolAbortSignalFor,
      log,
    });
  }

  // ─── Steering helper ──────────────────────────────────────────

  private evaluateSteering(
    messages: InternalMessage[],
    turn: number,
    consecutiveToolErrors: number,
    totalToolCalls: number,
    contextWindowTokens: number,
  ): { guidances: string[]; firedRules: string[] } {
    return evaluateSteeringCore(this.steeringEngine, messages, turn, consecutiveToolErrors, totalToolCalls, contextWindowTokens);
  }

  // ─── Single-turn chat ─────────────────────────────────────────

  /**
   * Single-turn convenience wrapper around `streamChat`.
   *
   * Aligned with Codex's single-loop architecture: every `chat()` call collects
   * events from `streamChat`, which is backed by `runAgentLoop`, and returns the
   * final `ChatResult`.
   */
  async chat(sessionKey: string, userMessage: string, options?: ChatOptions): Promise<ChatResult> {
    let finalResult: ChatResult | undefined;
    let lastError: string | undefined;
    for await (const event of this.streamChat(sessionKey, userMessage, options)) {
      if (event.type === 'done') {
        finalResult = event.result;
      } else if (event.type === 'error') {
        lastError = event.error;
      }
    }
    if (finalResult) return finalResult;
    if (lastError) throw new Error(lastError);
    return {
      response: '',
      toolCalls: [],
      toolResults: [],
      stopReason: 'empty_stream',
    };
  }

  // ─── Streaming chat ───────────────────────────────────────────

  private async *streamChatViaAgentLoop(
    sessionKey: string,
    userMessage: string,
    options?: ChatOptions,
  ): AsyncGenerator<DmossAgentEvent> {
    const store = this.config.sessionStore;
    const provider = this.config.llmProvider;
    const hooks = this.config.hooks;
    const maxTurns = this.config.maxAgentTurns
      ? resolveDmossMaxAgentTurns(String(this.config.maxAgentTurns))
      : resolveDmossMaxAgentTurns();
    const contextTokens = this.config.contextTokens ?? 200_000;
    const maxOutputTokens = this.config.maxTokens ?? 4096;
    const effectiveContextTokens = getEffectiveContextWindowTokens(contextTokens, maxOutputTokens);
    const temperature = options?.temperature ?? this.config.temperature;
    const runId = options?.runId ?? crypto.randomUUID();
    const abortSignal = options?.abortSignal ?? new AbortController().signal;

    const loadedMessages = (await store.loadMessages(sessionKey)) as unknown as InternalMessage[];
    const taskFrameLoad = splitTaskFrameCheckpointMessages(toSessionMessages(loadedMessages));
    const continuationIntent = detectContinuationIntent(userMessage);
    let taskFrame: TaskFrame = createOrUpdateTaskFrame({
      previous: taskFrameLoad.frame,
      sessionKey,
      runId,
      userMessage,
    });
    const messages = fromSessionMessages(taskFrameLoad.messages);
    const userMsg: InternalMessage = { role: 'user', content: userMessage, timestamp: Date.now() };
    messages.push(userMsg);
    await store.appendMessage(sessionKey, userMsg as unknown as LLMMessage);

    const workingContext = buildTaskFrameContext(taskFrame, continuationIntent);
    const extraContext = [options?.extraContext, workingContext].filter(Boolean).join('\n\n');
    const systemPrompt = this.buildSystemPrompt({
      platform: options?.platform,
      extraContext,
    });
    const allTools = [...this.tools.getAll(), ...(options?.ephemeralTools ?? [])];

    const toolCtx: ToolContext = {
      workspaceDir: process.cwd(),
      sessionKey,
      abortSignal,
    };

    const adapter = createDmossAgentLoopEventAdapter({
      isAbortError: () => abortSignal.aborted,
    });
    /** Preserve the final fatal agent error so `chat()` can surface a useful message. */
    let lastAgentFatalError: string | undefined;
    const activeToolCalls = new Map<string, ToolCall>();

    const persistTaskFrame = async (reason: string): Promise<DmossAgentEvent> => {
      const latest = await store.loadMessages(sessionKey);
      const cleanMessages = stripTaskFrameCheckpointsFromLlmMessages(latest);
      const checkpoint = createTaskFrameCheckpointMessage(taskFrame);
      const nextMessages = lastMessageNeedsToolFollowUp(cleanMessages)
        ? [...cleanMessages.slice(0, -1), checkpoint, cleanMessages[cleanMessages.length - 1]]
        : [...cleanMessages, checkpoint];
      await store.replaceMessages(sessionKey, nextMessages);
      return {
        type: 'working_context_checkpoint',
        status: taskFrame.status,
        reason,
        goal: taskFrame.goal,
        nextAction: taskFrame.nextAction,
      };
    };

    const streamFn = createStreamFunctionFromLlmProvider({
      provider,
      onRequest: (request) => {
        hooks?.onLLMRequestStart?.({
          model: request.model,
          messageCount: request.messages.length,
          toolCount: request.tools?.length ?? 0,
        });
      },
      onResponse: (response) => {
        hooks?.onLLMResponseEnd?.(response);
      },
      onError: async (error) => {
        await hooks?.onError?.(error, { attempt: 0, sessionKey });
      },
      onProviderEvent: (event) => {
        options?.onStream?.(event);
        hooks?.onStream?.(event);
      },
    });

    const summarize: SummarizeFn = async (params) => {
      const resp = await provider.complete({
        model: this.config.model ?? 'claude-sonnet-4-20250514',
        systemPrompt: params.system,
        messages: [{ role: 'user', content: params.userPrompt }],
        maxTokens: params.maxTokens,
      });
      return resp.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
    };

    const miniStream = runAgentLoop({
      runId,
      sessionKey,
      agentId: 'dmoss-agent',
      currentMessages: toSessionMessages(messages),
      compactionSummary: undefined,
      systemPrompt,
      toolsForRun: allTools,
      getToolsForRun: () => allTools,
      toolCtx,
      modelDef: createModelDefFromDmossConfig({
        ...this.config,
        maxTokens: maxOutputTokens,
        contextTokens,
      }),
      streamFn,
      temperature,
      reasoning: this.config.reasoning || undefined,
      maxTurns,
      contextTokens,
      getSteeringMessages: async () => [],
      appendMessage: async (key, msg) => {
        await store.appendMessage(key, msg as unknown as LLMMessage);
      },
      replaceMessages: async (key, nextMessages) => {
        await store.replaceMessages(key, nextMessages as unknown as LLMMessage[]);
      },
      prepareCompaction: async ({ messages: compactMessages, forceCompaction }) => {
        const compactResult = await compactHistoryIfNeeded({
          summarize,
          messages: compactMessages,
          contextWindowTokens: effectiveContextTokens,
          pruningSettings: this.config.pruningSettings,
          compactionSettings: this.config.compactionSettings,
          systemPrompt,
          charsPerTokenUnit: resolveContextCharsPerTokenUnit(),
          forceCompaction,
          remoteCompactProvider: this.remoteCompactProvider,
        });
        if (!compactResult.summary || !compactResult.summaryMessage) return {};
        return {
          summary: compactResult.summary,
          summaryMessage: compactResult.summaryMessage,
          droppedMessages: compactResult.pruneResult.droppedMessages.length,
          checkpointOutline: buildCompactionCheckpointOutline(compactResult.summary),
          messages: [compactResult.summaryMessage, ...compactResult.pruneResult.messages],
        };
      },
      checkToolApproval: hooks?.onBeforeToolExec
        ? async (call) => {
            const tool = allTools.find((t) => t.name === call.name);
            if (!tool) return null;
            const input =
              call.input && typeof call.input === 'object' && !Array.isArray(call.input)
                ? (call.input as Record<string, unknown>)
                : {};
            const decision = await hooks.onBeforeToolExec!({ tool, input, sessionKey });
            return decision.approved ? null : { approved: false, decision: 'deny' };
          }
        : undefined,
      toolAbortSignalFor: options?.toolAbortSignalFor,
      enrichToolContext: hooks?.enrichToolContext,
      abortSignal,
      maxOutputTokens,
      pruningSettings: this.config.pruningSettings,
      compactHooks: this.config.compactHooks,
      platform: {
        toolTimeoutMs: this.config.toolTimeoutMs,
      },
    });

    let completedToolCalls = 0;
    for await (const miniEvent of miniStream) {
      if (miniEvent.type === 'tool_execution_start') {
        const input =
          miniEvent.args && typeof miniEvent.args === 'object' && !Array.isArray(miniEvent.args)
            ? (miniEvent.args as Record<string, unknown>)
            : {};
        const call: ToolCall = { id: miniEvent.toolCallId, name: miniEvent.toolName, input };
        activeToolCalls.set(miniEvent.toolCallId, call);
        taskFrame = recordTaskFrameToolStart(taskFrame, miniEvent.toolName, input);
      } else if (miniEvent.type === 'tool_execution_end') {
        completedToolCalls += 1;
        const resultContent = miniEvent.content ?? miniEvent.result;
        const call = activeToolCalls.get(miniEvent.toolCallId) ?? {
          id: miniEvent.toolCallId,
          name: miniEvent.toolName,
          input: {},
        };
        const result: ToolResult = {
          toolUseId: miniEvent.toolCallId,
          content: resultContent,
          isError: miniEvent.isError,
          ...(miniEvent.aborted ? { aborted: miniEvent.aborted } : {}),
        };
        hooks?.onToolResult?.(call, result);
        taskFrame = recordTaskFrameToolEnd(taskFrame, {
          toolName: miniEvent.toolName,
          input: call.input,
          result: resultContent,
          isError: miniEvent.isError,
          ...(miniEvent.aborted ? { aborted: miniEvent.aborted } : {}),
        });
        if (taskFrame.status === 'paused_resumable' && taskFrame.source === 'guard') {
          yield await persistTaskFrame('tool_loop_guard');
        }
      } else if (miniEvent.type === 'compaction') {
        taskFrame = recordTaskFrameCompaction(taskFrame, {
          summaryChars: miniEvent.summaryChars,
          droppedMessages: miniEvent.droppedMessages,
        });
      } else if (miniEvent.type === 'turn_transition') {
        if (miniEvent.reason === 'aborted_by_user') {
          taskFrame = recordTaskFrameStop(taskFrame, { reason: 'abort' });
        } else if (miniEvent.reason === 'max_turns_reached') {
          taskFrame = recordTaskFrameStop(taskFrame, { reason: 'max_turns' });
        }
      } else if (miniEvent.type === 'agent_error') {
        if (!abortSignal.aborted) {
          lastAgentFatalError = miniEvent.error;
        }
        taskFrame = recordTaskFrameStop(taskFrame, {
          reason: abortSignal.aborted ? 'abort' : 'error',
          detail: miniEvent.error,
        });
      } else if (miniEvent.type === 'turn_end') {
        hooks?.onTurnComplete?.({
          turn: miniEvent.turn,
          maxTurns,
          toolCallCount: completedToolCalls,
        });
      }

      for (const event of adapter.onMiniEvent(miniEvent)) {
        yield event;
      }
    }

    const miniResult = await miniStream.result();
    const done = adapter.getDoneEvent(miniResult);
    if (done.result.stopReason === 'error') {
      throw new Error(lastAgentFatalError || 'LLM request failed');
    }
    if (taskFrame.status === 'active' || done.result.response.trim()) {
      taskFrame = recordTaskFrameAssistant(
        taskFrame,
        done.result.response,
        done.result.stopReason ?? 'end_turn',
      );
    }
    const checkpointEvent = await persistTaskFrame(
      done.result.stopReason === 'max_turns_reached' ? 'max_turns' : 'agent_loop_done',
    );
    if (taskFrame.status !== 'completed') {
      yield checkpointEvent;
    }

    // Auto-distill reusable skills from successful multi-step runs.
    // SkillLearner internally checks thresholds (confidence, dedup) before persisting.
    if (
      this.config.skillLearner &&
      taskFrame.status === 'completed' &&
      done.result.toolCalls.length >= 2
    ) {
      try {
        const sessionMessages = await store.loadMessages(sessionKey);
        const skillPath = await this.config.skillLearner.maybeLearnFromSession(
          sessionKey,
          sessionMessages as unknown as LLMMessage[],
        );
        if (skillPath) {
          log.info('auto-distilled skill from session', { sessionKey, skillPath });
        }
      } catch (err) {
        log.warn('skill learner failed (non-critical)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    yield done;
  }

  async *streamChat(
    sessionKey: string,
    userMessage: string,
    options?: ChatOptions,
  ): AsyncGenerator<DmossAgentEvent> {
    yield* this.streamChatViaAgentLoop(sessionKey, userMessage, options);
  }
}
