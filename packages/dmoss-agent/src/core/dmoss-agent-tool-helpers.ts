import { randomUUID } from 'node:crypto';

import type { LLMMessage, LLMContentBlock } from './llm-provider.js';
import type { SessionStore } from './session.js';
import type { Tool, ToolContext, ToolResult, ToolCall } from './tool-types.js';
import type { DmossAgentConfig, InternalMessage } from './dmoss-agent-types.js';
import { resolveHostToolIntentFallback } from './dmoss-agent-types.js';
import { canHostInjectToolWithEmptyInput } from './tool-types.js';
import { maybeSuppressRedundantWebFetchAfterOpenUrl } from './open-url-web-fetch-guard.js';
import { findReplayableToolResultContent } from './tool-idempotent-replay.js';
import { splitThinkingTagsFromAssistantText, stripThinkingTagsKeepVisible } from './inline-thinking-stream.js';
import { extractThinkingTagBodies, detectUnexecutedToolIntents, DEFAULT_FOLLOW_UP_GUARD_CONFIG, type FollowUpGuardConfig } from './follow-up-guard.js';
import { extractToolInvocationFromPlanText } from './extract-tool-invocation.js';
import { truncateToolOutput } from '../context/tool-output-truncate.js';
import { describeError } from '../provider/errors.js';
import { combineAbortSignals, abortable } from './abort.js';
import {
  createToolLoopGuardState,
  formatToolLoopGuardMessage,
  shouldShortCircuitToolCall,
} from './tool-loop-guard.js';
import type { ToolLoopGuardState } from './tool-loop-guard.js';
import { validateToolInputObject } from './tool-pipeline.js';

type LoggerLike = {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
};

export type ToolUseBlock = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolUseBlockWithType = ToolUseBlock & { type: 'tool_use' };

export function extractVisibleAssistantText(content: LLMContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => {
      const { visible } = splitThinkingTagsFromAssistantText(b.text);
      return visible || stripThinkingTagsKeepVisible(b.text);
    })
    .filter((text) => text.trim().length > 0)
    .join('');
}

export function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  allTools: Tool[],
  ctx: Pick<ToolContext, 'sessionKey' | 'sessionId'>,
  log: LoggerLike,
): Record<string, unknown> {
  const tool = allTools.find((t) => t.name === toolName);
  if (!tool?.normalizeInput) return input;
  try {
    const normalized = tool.normalizeInput(input, ctx);
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
  } catch (err) {
    log.warn('tool input normalizer failed; using original input', {
      tool: toolName,
      error: describeError(err),
    });
  }
  return input;
}

export function normalizeToolUseBlocksInContent(
  content: LLMContentBlock[],
  allTools: Tool[],
  ctx: Pick<ToolContext, 'sessionKey' | 'sessionId'>,
  log: LoggerLike,
): void {
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    block.input = normalizeToolInput(block.name, block.input, allTools, ctx, log);
  }
}

export function buildFollowUpGuardMessages(messages: InternalMessage[]): LLMMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') {
      return msg as unknown as LLMMessage;
    }
    if (typeof msg.content === 'string') {
      return {
        role: 'assistant',
        content: stripThinkingTagsKeepVisible(msg.content),
      } satisfies LLMMessage;
    }
    /** 保留完整 text 块（含 `<redacted_thinking>`），供 `detectUnexecutedToolIntents` 在「仅思考、可见为空」时解析 */
    return {
      role: 'assistant',
      content: msg.content as unknown as LLMContentBlock[],
    } satisfies LLMMessage;
  });
}

export async function tryInjectHostToolUseFromIntent(
  params: {
    config: DmossAgentConfig;
    messages: InternalMessage[];
    sessionKey: string;
    store: SessionStore;
    allTools: Tool[];
    followUpConfig: Partial<FollowUpGuardConfig>;
    log: LoggerLike;
  },
): Promise<ToolUseBlockWithType | null> {
  if (!resolveHostToolIntentFallback(params.config)) return null;

  const { config, messages, sessionKey, store, allTools, followUpConfig, log } = params;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return null;

  /** 聚合可见正文 + 思考链原文，作为提取器的输入 */
  const textBlocks = (last.content as LLMContentBlock[])
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text);
  const rawAssistantText = textBlocks.join('\n');
  const thinkingFromTags = extractThinkingTagBodies(rawAssistantText);
  const planText = `${rawAssistantText}\n${thinkingFromTags}`.trim();

  /** 档 1：从规划里完整抽出工具调用（带真实参数）*/
  const extracted = planText ? extractToolInvocationFromPlanText(planText, allTools) : null;
  if (extracted) {
    const tool = allTools.find((t) => t.name === extracted.name);
    if (tool) {
      const id = `host_${randomUUID()}`;
      const input = normalizeToolInput(tool.name, extracted.input, allTools, { sessionKey }, log);
      const block = { type: 'tool_use' as const, id, name: tool.name, input };
      (last.content as LLMContentBlock[]).push(block);
      await store.replaceMessages(sessionKey, messages as unknown as LLMMessage[]);
      if (process.env.DMOSS_QUIET !== 'true') {
        log.info('host tool invocation injected from plan text', {
          tool: tool.name,
          required: extracted.satisfiedRequired,
          sessionKey,
        });
      }
      return block;
    }
  }

  /** 档 2/3：回退到原有「意图 → 空参注入」路径（保留对 device_list_all 等无参工具的兼容） */
  const merged = { ...DEFAULT_FOLLOW_UP_GUARD_CONFIG, ...followUpConfig };
  const intents = detectUnexecutedToolIntents(
    buildFollowUpGuardMessages(messages),
    merged.extraPatterns,
    merged.maxFollowUps ?? 1,
  );
  if (intents.length === 0) return null;

  for (const intent of intents) {
    const tool = allTools.find((t) => t.name === intent.expectedTool);
    if (!tool) continue;
    if (!canHostInjectToolWithEmptyInput(tool)) {
      if (process.env.DMOSS_QUIET !== 'true') {
        log.info(
          'host tool fallback skipped (has required fields, cannot auto-invoke empty input)',
          { tool: intent.expectedTool },
        );
      }
      continue;
    }
    const id = `host_${randomUUID()}`;
    const input = normalizeToolInput(tool.name, {}, allTools, { sessionKey }, log);
    const block = { type: 'tool_use' as const, id, name: tool.name, input };
    (last.content as LLMContentBlock[]).push(block);
    await store.replaceMessages(sessionKey, messages as unknown as LLMMessage[]);
    if (process.env.DMOSS_QUIET !== 'true') {
      log.info('host tool fallback: injected empty-input tool_use', { tool: tool.name, sessionKey });
    }
    return block;
  }
  return null;
}

export async function executeToolBlock(
  block: ToolUseBlock,
  allTools: Tool[],
  sessionKey: string,
  config: DmossAgentConfig,
  options: {
    abortSignal?: AbortSignal;
    toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
    log: LoggerLike;
  },
): Promise<{ resultContent: string; isError: boolean; aborted?: { by: 'user' | 'timeout' }}> {
  const hooks = config.hooks;
  const enableTruncation = config.enableToolOutputTruncation ?? true;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30 * 60 * 1000;

  const tool = allTools.find((t) => t.name === block.name);
  let resultContent: string;
  let isError = false;
  let aborted: { by: 'user' | 'timeout' } | undefined;
  let perToolAbort: AbortSignal | undefined;

  if (!tool) {
    return { resultContent: `Error: Unknown tool "${block.name}"`, isError: true };
  }

  try {
    const schemaCheck = validateToolInputObject(tool, block.input);
    if (!schemaCheck.ok) {
      return { resultContent: schemaCheck.message, isError: true };
    }
    block.input = schemaCheck.value;

    if (hooks?.onBeforeToolExec) {
      const decision = await hooks.onBeforeToolExec({ tool, input: block.input, sessionKey });
      if (!decision.approved) {
        return { resultContent: `Tool execution denied: ${decision.reason}`, isError: true };
      }
    }
  } catch (err) {
    return { resultContent: `Tool preflight error: ${describeError(err)}`, isError: true };
  }

  try {
    perToolAbort = options.toolAbortSignalFor?.(block.id);
    const mergedAbort = combineAbortSignals(options.abortSignal, perToolAbort);
    let ctx: ToolContext = {
      workspaceDir: process.cwd(),
      sessionKey,
      abortSignal: mergedAbort,
      toolCallId: block.id,
    };
    if (hooks?.enrichToolContext) {
      ctx = hooks.enrichToolContext(ctx, sessionKey);
    }
    const execPromise = tool.execute(block.input, ctx);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>(
      (_, reject) =>
        (timeoutHandle = setTimeout(
          () => reject(new Error(`Tool ${block.name} timed out (${toolTimeoutMs / 1000}s)`)),
          toolTimeoutMs,
        )),
    );
    try {
      resultContent = await Promise.race([
        mergedAbort ? abortable(execPromise, mergedAbort) : execPromise,
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (perToolAbort?.aborted && !options.abortSignal?.aborted) {
      aborted = { by: 'user' };
      resultContent = 'Error: aborted_by_user: user cancelled this tool execution';
    } else if (/timed out/i.test(rawMessage)) {
      aborted = { by: 'timeout' };
      resultContent = `Error: ${rawMessage}`;
    } else {
      resultContent = `Error: ${rawMessage}`;
    }
    isError = true;
  }

  if (enableTruncation) {
    resultContent = truncateToolOutput(block.name, resultContent);
  }

  return { resultContent, isError, aborted };
}

export async function executeToolBlockWithHistory(
  block: ToolUseBlock,
  historyBeforeAssistant: LLMMessage[],
  allTools: Tool[],
  sessionKey: string,
  toolLoopGuard: ToolLoopGuardState,
  config: DmossAgentConfig,
  options: {
    abortSignal?: AbortSignal;
    toolAbortSignalFor?: (toolCallId: string) => AbortSignal | undefined;
    log: LoggerLike;
  },
): Promise<{ resultContent: string; isError: boolean; aborted?: { by: 'user' | 'timeout' }}> {
  const loopReason = shouldShortCircuitToolCall(toolLoopGuard, block.name, block.input);
  if (loopReason) {
    options.log.warn('tool loop guard short-circuited tool call', {
      tool: block.name,
      reason: loopReason,
      sessionKey,
    });
    return { resultContent: formatToolLoopGuardMessage(loopReason, block.name), isError: true };
  }

  const fetchSuppressed =
    block.name === 'web_fetch'
      ? maybeSuppressRedundantWebFetchAfterOpenUrl(
          historyBeforeAssistant,
          String((block.input as Record<string, unknown>)?.url ?? ''),
        )
      : null;

  if (fetchSuppressed) {
    options.log.info('web_fetch suppressed (open_url already opened the page)', {
      url: (block.input as Record<string, unknown>)?.url,
    });
    return { resultContent: fetchSuppressed, isError: false };
  }

  const replayed = findReplayableToolResultContent(
    historyBeforeAssistant,
    block.name,
    block.input,
    6,
  );

  if (replayed) {
    options.log.info('tool replay: reusing recent identical-params result', { tool: block.name });
    return { resultContent: replayed, isError: false };
  }

  return executeToolBlock(block, allTools, sessionKey, config, {
    abortSignal: options.abortSignal,
    toolAbortSignalFor: options.toolAbortSignalFor,
    log: options.log,
  });
}

export function createToolLoopGuardStateFacade(): ToolLoopGuardState {
  return createToolLoopGuardState();
}
