import type {
  Context as PiContext,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  ThinkingLevel,
} from '../../provider/pi-ai-types.js';
import type { MiniAgentEvent } from '../subagent/agent-events.js';
import type { ContentBlock, Message } from '../session/session-jsonl.js';
import type { Tool } from '../tools/tool-types.js';
import { retryAsync } from '../../provider/errors.js';
import { abortable, combineAbortSignals } from '../agent/abort.js';
import {
  createInlineThinkingRouter,
  splitThinkingTagsFromAssistantText,
} from '../llm/inline-thinking-stream.js';
import { shouldSuppressReasoningForToolFollowUpRound } from './follow-up-guard.js';
import { normalizeToolCallInput } from './agent-loop-tool-helpers.js';
import {
  classifyLlmError,
  retryDelayForLlmError,
} from '../llm/llm-error-classifier.js';
import { parseEnvBoundedInt } from '../../utils/env-compat.js';
import { DmossError, ErrorCode } from '../../errors.js';

/** Extended event shape for pi-ai stream events with optional delta/error/reason fields. */
interface PiStreamEventExt {
  type: string;
  delta?: string;
  text?: string;
  error?: { errorMessage?: string; message?: string };
  reason?: string;
}

export function resolveLlmFirstChunkTimeoutMs(): number {
  return parseEnvBoundedInt('DMOSS_LLM_FIRST_CHUNK_TIMEOUT_MS', 0, 0, 3_600_000);
}

export class LlmFirstChunkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmFirstChunkTimeoutError';
  }
}

const MESSAGE_DELTA_CATCHUP_CHUNK = 96;

export async function pushMessageDeltaCatchup(
  stream: { push: (e: MiniAgentEvent) => void },
  text: string,
  signal: AbortSignal,
): Promise<void> {
  if (!text) return;
  const step = MESSAGE_DELTA_CATCHUP_CHUNK;
  for (let i = 0; i < text.length; i += step) {
    if (signal.aborted) break;
    const delta = text.slice(i, i + step);
    if (delta) stream.push({ type: 'message_delta', delta });
    if (i + step < text.length) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

export async function pushThinkingDeltaCatchup(
  stream: { push: (e: MiniAgentEvent) => void },
  body: string,
  signal: AbortSignal,
): Promise<void> {
  if (!body || signal.aborted) return;
  const step = 72;
  for (let i = 0; i < body.length; i += step) {
    if (signal.aborted) break;
    const delta = body.slice(i, i + step);
    if (delta) stream.push({ type: 'thinking_delta', delta });
    if (i + step < body.length) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }
}

export function chainTopPOnPayload(
  topP: number,
  existing?: SimpleStreamOptions['onPayload'],
): SimpleStreamOptions['onPayload'] {
  return (payload: unknown) => {
    if (payload && typeof payload === 'object') {
      (payload as Record<string, unknown>).top_p = topP;
    }
    existing?.(payload);
  };
}

export interface AgentLoopLlmTurnParams {
  stream: { push: (event: MiniAgentEvent) => void };
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
  turn: number;
  runStartMs: number;
  firstTokenMs: number | null;
  suppressVisibleDeltas?: boolean;
  logDebug: (message: string, meta?: Record<string, unknown>) => void;
}

export interface AgentLoopLlmTurnResult {
  assistantContent: ContentBlock[];
  messageThinkingChunks: string[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  turnTextParts: string[];
  streamStopReason: StopReason | undefined;
  firstTokenMs: number | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function runAgentLoopLlmTurn(params: AgentLoopLlmTurnParams): Promise<AgentLoopLlmTurnResult> {
  const {
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
    suppressVisibleDeltas,
  } = params;
  let firstTokenMs = params.firstTokenMs;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const assistantContent: ContentBlock[] = [];
  /**
   * Per-turn reasoning collector (industry-standard one-shot per-turn
   * channel). Filled by `thinking_delta` / `thinking_end` events and
   * by inline `<thinking>` tags split out of `text_end` raw content.
   * Persisted onto `assistantMsg.thinking`; `message-convert.ts`
   * decides whether the current provider-facing request must round-trip
   * it as native reasoning history.
   */
  const messageThinkingChunks: string[] = [];
  const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  const turnTextParts: string[] = [];
  let currentThinkingParts: string[] | null = null;
  let streamStopReason: StopReason | undefined;

  await retryAsync(
      async () => {
        assistantContent.length = 0;
        messageThinkingChunks.length = 0;
        toolCalls.length = 0;
        turnTextParts.length = 0;
        streamStopReason = undefined;
        currentThinkingParts = null;

        const inlineThinking = createInlineThinkingRouter();
        let streamedVisibleAccum = '';
        let thinkingStreamedToClient = false;
        const markThinkingStreamed = (delta: unknown) => {
          if (String(delta ?? '').length > 0) thinkingStreamedToClient = true;
        };

        const firstChunkBudgetMs = resolveLlmFirstChunkTimeoutMs();
        const firstChunkCtrl = new AbortController();
        let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
        let firstChunkTimedOut = false;
        const clearFirstChunkTimer = () => {
          if (firstChunkTimer != null) {
            clearTimeout(firstChunkTimer);
            firstChunkTimer = null;
          }
        };
        if (firstChunkBudgetMs > 0) {
          firstChunkTimer = setTimeout(() => {
            firstChunkTimedOut = true;
            clearFirstChunkTimer();
            try {
              firstChunkCtrl.abort();
            } catch {
              /* noop */
            }
          }, firstChunkBudgetMs);
        }
        const streamSignal =
          combineAbortSignals(abortSignal, firstChunkCtrl.signal) ?? abortSignal;

        try {
          /**
           * 工具结果跟进轮只抑制新的 reasoning_effort；model 上的 reasoning 标记仍需保留，
           * 因为 OpenAI-compatible thinking 网关可能要求历史 assistant 的 reasoning_content
           * 原样回传。
           */
          const modelReasoningConfigured =
            Boolean(reasoning) ||
            Boolean((modelDef as Model<any> & { reasoning?: unknown }).reasoning);
          const suppressReasoningAfterToolUse =
            modelReasoningConfigured &&
            shouldSuppressReasoningForToolFollowUpRound(messagesForModel);
          if (suppressReasoningAfterToolUse) {
            params.logDebug(
              'suppressing reasoning for tool-result follow-up LLM call (provider compatibility)',
              { sessionKey, turn: turns, model: modelDef.id },
            );
          }
          const streamOpts: SimpleStreamOptions = {
            maxTokens: modelDef.maxTokens,
            signal: streamSignal,
            apiKey,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(reasoning && !suppressReasoningAfterToolUse ? { reasoning } : {}),
            ...(topP !== undefined ? { onPayload: chainTopPOnPayload(topP) } : {}),
          };
          const eventStream = streamFn(modelDef, piContext, streamOpts);

          for await (const event of eventStream) {
            if (abortSignal.aborted) break;
            clearFirstChunkTimer();

            switch (event.type) {
              case 'thinking_delta': {
                const ext = event as PiStreamEventExt;
                const td = ext.delta ?? '';
                markThinkingStreamed(td);
                stream.push({ type: 'thinking_delta', delta: td });
                if (!currentThinkingParts) currentThinkingParts = [];
                currentThinkingParts.push(td);
                break;
              }

              case 'thinking_end':
                if (currentThinkingParts && currentThinkingParts.length > 0) {
                  const thinkingText = currentThinkingParts.join('');
                  if (thinkingText.trim()) {
                    /** Industry-standard separation: thinking goes onto the message's
                     *  reasoning channel, not into a `<thinking>` text content block
                     *  (which would persist into next-turn context and trigger runaway
                     *  planner-speak). See Message.thinking docs in session-jsonl.ts. */
                    messageThinkingChunks.push(thinkingText);
                  }
                  currentThinkingParts = null;
                }
                break;

              case 'text_delta': {
                const routed = inlineThinking.push(event.delta);
                if (routed.thinking.length > 0 || routed.message.length > 0) {
                  if (firstTokenMs == null) firstTokenMs = Date.now() - runStartMs;
                }
                for (const th of routed.thinking) {
                  markThinkingStreamed(th);
                  stream.push({ type: 'thinking_delta', delta: th });
                  if (!currentThinkingParts) currentThinkingParts = [];
                  currentThinkingParts.push(th);
                }
                for (const msg of routed.message) {
                  if (!suppressVisibleDeltas) {
                    stream.push({ type: 'message_delta', delta: msg });
                  }
                  streamedVisibleAccum += msg;
                }
                break;
              }

              case 'text_end': {
                const raw = String(event.content ?? '');
                const { thinkingBodies, visible } = splitThinkingTagsFromAssistantText(raw);

                /** Industry-standard separation: inline `<thinking>` tags split out
                 *  of the raw text feed reasoning content; collect into
                 *  messageThinkingChunks (NOT into assistantContent text blocks). */
                for (const body of thinkingBodies) {
                  const t = body.trim();
                  if (t) messageThinkingChunks.push(t);
                }

                if (thinkingBodies.length > 0) {
                  currentThinkingParts = null;
                } else if (currentThinkingParts && currentThinkingParts.length > 0) {
                  const thinkingText = currentThinkingParts.join('').trim();
                  if (thinkingText) {
                    messageThinkingChunks.push(thinkingText);
                  }
                  currentThinkingParts = null;
                } else {
                  currentThinkingParts = null;
                }

                if (visible.trim()) {
                  assistantContent.push({ type: 'text', text: visible });
                }
                turnTextParts.push(visible);

                if (
                  !thinkingStreamedToClient &&
                  thinkingBodies.length > 0 &&
                  !abortSignal.aborted
                ) {
                  for (const body of thinkingBodies) {
                    if (!body || abortSignal.aborted) continue;
                    await pushThinkingDeltaCatchup(stream, body, abortSignal);
                    thinkingStreamedToClient = true;
                  }
                }

                let catchUp = '';
                if (visible === streamedVisibleAccum) {
                  catchUp = '';
                } else if (visible.startsWith(streamedVisibleAccum)) {
                  catchUp = visible.slice(streamedVisibleAccum.length);
                } else if (!streamedVisibleAccum.trim()) {
                  catchUp = visible;
                }

                if (catchUp && !abortSignal.aborted && !suppressVisibleDeltas) {
                  if (firstTokenMs == null) firstTokenMs = Date.now() - runStartMs;
                  await pushMessageDeltaCatchup(stream, catchUp, abortSignal);
                }

                streamedVisibleAccum = '';
                inlineThinking.reset();
                thinkingStreamedToClient = false;
                break;
              }

              case 'toolcall_start':
                break;

              case 'toolcall_end': {
                const tc = event.toolCall;
                const rawArgs = tc.arguments as Record<string, unknown>;
                const tcArgs = normalizeToolCallInput(
                  { name: tc.name, input: rawArgs },
                  toolsForRun,
                  { sessionKey },
                );
                assistantContent.push({
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.name,
                  input: tcArgs,
                });
                toolCalls.push({
                  id: tc.id,
                  name: tc.name,
                  input: tcArgs,
                });
                break;
              }

              case 'error': {
                // Type bridge: extending stream event with additional fields
                const ext = event as unknown as PiStreamEventExt;
                const errObj = ext.error;
                const errMsg =
                  errObj?.errorMessage ??
                  (errObj instanceof Error ? errObj.message : null) ??
                  'unknown stream error';
                throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `LLM stream error: ${errMsg}` });
              }
            }
          }

          const orphan = inlineThinking.end();
          for (const th of orphan.thinking) {
            markThinkingStreamed(th);
            stream.push({ type: 'thinking_delta', delta: th });
            if (!currentThinkingParts) currentThinkingParts = [];
            currentThinkingParts.push(th);
          }
          for (const msg of orphan.message) {
            if (firstTokenMs == null) firstTokenMs = Date.now() - runStartMs;
            if (!suppressVisibleDeltas) {
              stream.push({ type: 'message_delta', delta: msg });
            }
            streamedVisibleAccum += msg;
          }
          if (currentThinkingParts && currentThinkingParts.length > 0) {
            const t = currentThinkingParts.join('').trim();
            if (t) {
              /** Industry-standard separation (orphan thinking after stream end) */
              messageThinkingChunks.push(t);
            }
            currentThinkingParts = null;
          }
          if (streamedVisibleAccum.trim()) {
            assistantContent.push({ type: 'text', text: streamedVisibleAccum });
            turnTextParts.push(streamedVisibleAccum);
          }
          streamedVisibleAccum = '';

          clearFirstChunkTimer();
          const piAssistant = await abortable(eventStream.result(), abortSignal);
          streamStopReason = piAssistant.stopReason;
          usage = {
            inputTokens: piAssistant.usage.input,
            outputTokens: piAssistant.usage.output,
          };

          /** 部分网关仅把完整 assistant 放在 result.content，流式事件未写入 assistantContent → message_end 空 */
          const llmTail = (piAssistant as { content?: unknown[] }).content;
          if (
            toolCalls.length === 0 &&
            assistantContent.length === 0 &&
            Array.isArray(llmTail) &&
            llmTail.length > 0 &&
            !abortSignal.aborted
          ) {
            for (const raw of llmTail) {
              const block = raw as { type?: string; text?: string };
              if (
                block?.type !== 'text' ||
                typeof block.text !== 'string' ||
                !block.text.trim()
              ) {
                continue;
              }
              const { thinkingBodies, visible } = splitThinkingTagsFromAssistantText(
                block.text,
              );
              for (const body of thinkingBodies) {
                if (!body.trim()) continue;
                /** Industry-standard separation: tail-recovery thinking
                 *  goes onto the message reasoning channel, not into
                 *  `<thinking>` text content blocks. */
                messageThinkingChunks.push(body.trim());
                await pushThinkingDeltaCatchup(stream, body, abortSignal);
              }
              if (visible.trim()) {
                assistantContent.push({ type: 'text', text: visible });
                turnTextParts.push(visible);
                if (!suppressVisibleDeltas) {
                  await pushMessageDeltaCatchup(stream, visible, abortSignal);
                }
              }
            }
          }
        } catch (streamErr) {
          clearFirstChunkTimer();
          if (firstChunkTimedOut && !abortSignal.aborted) {
            throw new LlmFirstChunkTimeoutError(
              `LLM produced no streaming output (including thinking) within ${Math.round(firstChunkBudgetMs / 1000)}s. Check network/proxy, Base URL, API Key and model availability; or try disabling extended thinking or switching models.`,
            );
          }
          throw streamErr;
        } finally {
          clearFirstChunkTimer();
        }
      },
      {
        attempts: 3,
        minDelayMs: 300,
        maxDelayMs: 30_000,
        jitter: 0.25,
        label: 'llm-call',
        shouldRetry: (err) => {
          if (abortSignal.aborted) return false;
          return classifyLlmError(err).retryable;
        },
        retryDelayMs: (err, attempt, _computed) => {
          const classification = classifyLlmError(err);
          return retryDelayForLlmError(classification, attempt);
        },
        onRetry: ({ attempt, delay, error }) => {
          const classification = classifyLlmError(error);
          stream.push({
            type: 'retry',
            attempt,
            delay,
            error: classification.message,
            category: classification.category,
          });
        },
      },
  );

  return {
    assistantContent,
    messageThinkingChunks,
    toolCalls,
    turnTextParts,
    streamStopReason,
    firstTokenMs,
    usage,
  };
}
