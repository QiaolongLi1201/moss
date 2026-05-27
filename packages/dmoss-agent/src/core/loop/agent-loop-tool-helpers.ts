import { getRootLogger } from '../../logger.js';
import { describeError } from '../../provider/errors.js';
import type { Tool } from '../tools/tool-types.js';
import type { ContentBlock } from '../session/session-jsonl.js';

const log = getRootLogger().child('agent:loop');

export interface ToolExecGroup {
  calls: { id: string; name: string; input: Record<string, unknown> }[];
  parallel: boolean;
}

/** Frontend-facing tool result preview. Full context still receives the truncated tool output. */
export function formatToolResultForSsePreview(truncatedResult: string, isError: boolean): string {
  if (isError) {
    return truncatedResult.length > 500 ? `${truncatedResult.slice(0, 500)}...` : truncatedResult;
  }
  const trimmed = truncatedResult.trimStart();
  if (trimmed.startsWith('{') && trimmed.includes('"__type"')) {
    const max = 12_000;
    return truncatedResult.length > max ? `${truncatedResult.slice(0, max)}...` : truncatedResult;
  }
  return truncatedResult.length > 500 ? `${truncatedResult.slice(0, 500)}...` : truncatedResult;
}

export function skipToolCall(call: { id: string; name: string }): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    name: call.name,
    content: 'Skipped due to queued user message.',
  };
}

export function normalizeToolCallInput(
  call: { name: string; input: Record<string, unknown> },
  toolsForRun: Tool[],
  ctx: { sessionKey: string },
): Record<string, unknown> {
  const tool = toolsForRun.find((t) => t.name === call.name);
  if (!tool?.normalizeInput) return call.input;
  try {
    const normalized = tool.normalizeInput(call.input, { sessionKey: ctx.sessionKey });
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      return normalized as Record<string, unknown>;
    }
  } catch (err) {
    log.warn('tool input normalizer failed; using original input', {
      tool: call.name,
      error: describeError(err),
    });
  }
  return call.input;
}

export function syncAssistantToolUseInput(
  assistantContent: ContentBlock[],
  call: { id: string; input: Record<string, unknown> },
): void {
  for (const block of assistantContent) {
    if (block.type === 'tool_use' && block.id === call.id) {
      block.input = call.input;
    }
  }
}

export function groupToolCallsForExecution(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  parallelSafeTools: Set<string>,
  loadToolsMetaName?: string,
): ToolExecGroup[] {
  const ordered = partitionLoadToolsFirst(calls, loadToolsMetaName);
  if (ordered.length <= 1) return [{ calls: ordered, parallel: false }];
  const groups: ToolExecGroup[] = [];
  let pending: typeof ordered = [];
  for (const call of ordered) {
    if (loadToolsMetaName && call.name === loadToolsMetaName) {
      if (pending.length > 0) {
        groups.push({ calls: pending, parallel: true });
        pending = [];
      }
      groups.push({ calls: [call], parallel: false });
      continue;
    }
    if (parallelSafeTools.has(call.name)) {
      pending.push(call);
    } else {
      if (pending.length > 0) {
        groups.push({ calls: pending, parallel: true });
        pending = [];
      }
      groups.push({ calls: [call], parallel: false });
    }
  }
  if (pending.length > 0) groups.push({ calls: pending, parallel: true });
  return groups;
}

export function partitionLoadToolsFirst(
  calls: { id: string; name: string; input: Record<string, unknown> }[],
  loadToolsMetaName?: string,
): typeof calls {
  if (!loadToolsMetaName) return calls;
  const loads = calls.filter((c) => c.name === loadToolsMetaName);
  const rest = calls.filter((c) => c.name !== loadToolsMetaName);
  return [...loads, ...rest];
}
