import type { ContentBlock, Message } from './session-jsonl.js';
import type { Tool } from './tool-types.js';
import { randomUUID } from 'node:crypto';
import { extractToolInvocationFromPlanText } from './extract-tool-invocation.js';
import { splitThinkingTagsFromAssistantText } from './inline-thinking-stream.js';
import {
  normalizeToolCallInput,
  syncAssistantToolUseInput,
} from './agent-loop-tool-helpers.js';

function extractVisibleTextFromThinkingBlocks(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const { thinkingBodies } = splitThinkingTagsFromAssistantText(block.text);
    for (const b of thinkingBodies) {
      const t = b.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

/**
 * Read reasoning text from an in-progress assistant message.
 *
 * Prefers the new `Message.thinking` array (provider-native reasoning channel,
 * industry-standard one-shot per-turn reasoning). Falls back to extracting
 * `<thinking>...</thinking>` tag bodies from text content blocks for legacy
 * sessions and for upstream models that emit inline tags inside `text_delta`
 * (rather than via a dedicated `thinking_delta` event).
 */
export function extractThinkingTextFromMessage(
  thinkingChunks: ReadonlyArray<string> | undefined,
  content: ContentBlock[],
): string {
  if (Array.isArray(thinkingChunks) && thinkingChunks.length > 0) {
    return thinkingChunks.join('\n\n').trim();
  }
  return extractVisibleTextFromThinkingBlocks(content);
}

export function hasAssistantThinkingHistory(messages: readonly Message[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === 'assistant' &&
      Array.isArray(msg.thinking) &&
      msg.thinking.some((chunk) => String(chunk ?? '').trim()),
  );
}

export function isThinkingOnlyAssistantTurn(params: {
  visibleText: string;
  toolCallCount: number;
  thinkingChunks: ReadonlyArray<string>;
  assistantContent: ContentBlock[];
}): boolean {
  if (params.visibleText.trim() || params.toolCallCount > 0) return false;
  if (params.thinkingChunks.length > 0) return true;
  return params.assistantContent.some((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return false;
    const head = block.text.trimStart();
    return head.startsWith('<thinking>') || head.startsWith('<think>');
  });
}

export function buildThinkingOnlyUserHint(totalToolCalls: number): string {
  if (totalToolCalls > 0) {
    return [
      '> 工具调用已经执行，但模型最后只产出了推理过程，没有生成可见总结。',
      '> 这通常是 reasoning 模式在工具结果跟进轮耗尽了输出 token。',
      '> 建议：重试一次或切换到「快捷回答」模式；工具执行详情仍可在上方工具记录里查看。',
    ].join('\n');
  }
  return [
    '> 模型产出了推理过程但未生成可见回复或工具调用。',
    '> 这通常是因为 reasoning 模式消耗了所有输出 token。',
    '> 建议：切换到「快捷回答」模式，或联系管理员检查模型 API 的 reasoning 配置。',
  ].join('\n');
}

export function buildVisibleAssistantText(params: {
  textParts: ReadonlyArray<string>;
  thinkingFallback: string;
}): string {
  return (
    params.textParts
      .join('')
      .replace(/<\|FunctionCallBegin\|>[\s\S]*?<\|FunctionCallEnd\|>/g, '')
      .replace(/<\|FunctionCallBegin\|>[\s\S]*$/, '')
      .trim() || params.thinkingFallback
  );
}

/**
 * Some reasoning models mention "I will call tool X for URL Y" in visible text
 * or thinking, but never emit a tool_use. These predicates decide whether the
 * loop should add one corrective model turn.
 */
export function shouldNudgeMissingToolInvocationFromPlan(
  visibleAssistantText: string,
  namedWebToolRe: RegExp,
): boolean {
  const t = visibleAssistantText.trim();
  if (t.length < 30) return false;
  if (!/https?:\/\//i.test(t)) return false;
  if (!namedWebToolRe.test(t)) return false;
  const firstPersonIntent = /(?:我(?:来|要|去|将|先)|让我).{0,20}调用/i.test(t);
  return firstPersonIntent;
}

export function shouldNudgeMissingToolInvocationFromThinking(
  thinkingText: string,
  namedWebToolRe: RegExp,
): boolean {
  const t = thinkingText.trim();
  if (t.length < 30) return false;
  if (!/https?:\/\//i.test(t)) return false;
  if (!namedWebToolRe.test(t)) return false;
  const planIntent =
    /(?:我(?:来|要|去|将|先)|让我|然后|接下来|紧接(?:下来|着)|最后|下一步|下面|首先|随后).{0,20}调用/i.test(
      t,
    );
  return planIntent;
}

export type AgentLoopToolCallDraft = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export function injectToolCallFromPlanText(params: {
  toolCalls: AgentLoopToolCallDraft[];
  assistantContent: ContentBlock[];
  turnTextParts: string[];
  messageThinkingChunks: string[];
  toolsForRun: Tool[];
  sessionKey: string;
  logInfo?: (message: string, meta?: Record<string, unknown>) => void;
}): void {
  if (params.toolCalls.length > 0) return;
  const visibleForExtract = params.turnTextParts.join('').trim();
  const thinkingForExtract = extractThinkingTextFromMessage(
    params.messageThinkingChunks,
    params.assistantContent,
  );
  const planText = [visibleForExtract, thinkingForExtract].filter(Boolean).join('\n\n');
  if (!planText) return;

  const extracted = extractToolInvocationFromPlanText(planText, params.toolsForRun);
  if (!extracted) return;

  const injectedId = `host_${randomUUID()}`;
  const injectedInput = normalizeToolCallInput(
    { name: extracted.name, input: extracted.input },
    params.toolsForRun,
    { sessionKey: params.sessionKey },
  );
  params.assistantContent.push({
    type: 'tool_use',
    id: injectedId,
    name: extracted.name,
    input: injectedInput,
  });
  params.toolCalls.push({ id: injectedId, name: extracted.name, input: injectedInput });
  params.logInfo?.('host tool invocation injected from plan text', {
    tool: extracted.name,
    required: extracted.satisfiedRequired,
    sessionKey: params.sessionKey,
  });
}

export function normalizeAssistantToolCalls(params: {
  toolCalls: AgentLoopToolCallDraft[];
  assistantContent: ContentBlock[];
  toolsForRun: Tool[];
  sessionKey: string;
}): void {
  for (const call of params.toolCalls) {
    call.input = normalizeToolCallInput(call, params.toolsForRun, { sessionKey: params.sessionKey });
    syncAssistantToolUseInput(params.assistantContent, call);
  }
}

export function shouldNudgeMissingToolInvocation(params: {
  finalText: string;
  messageThinkingChunks: string[];
  assistantContent: ContentBlock[];
  namedWebToolRe: RegExp;
}): boolean {
  const visibleHits =
    !!params.finalText.trim() &&
    shouldNudgeMissingToolInvocationFromPlan(params.finalText, params.namedWebToolRe);
  if (visibleHits) return true;
  const thinkingPlanText = extractThinkingTextFromMessage(
    params.messageThinkingChunks,
    params.assistantContent,
  );
  return (
    !!thinkingPlanText &&
    shouldNudgeMissingToolInvocationFromThinking(thinkingPlanText, params.namedWebToolRe)
  );
}
