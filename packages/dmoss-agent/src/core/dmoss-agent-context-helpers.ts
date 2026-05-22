import type { LLMProvider } from './llm-provider.js';
import type { DmossAgentConfig, InternalMessage } from './dmoss-agent-types.js';
import { toSessionMessages } from './dmoss-agent-types.js';
import { pruneContextMessages, type PruneResult } from '../context/pruning.js';
import { microcompact } from '../context/microcompact.js';
import { snipTailOversizedToolResults } from '../context/tail-tool-snip.js';
import { invalidateStaleReadToolResults } from '../context/stale-read-invalidate.js';
import {
  estimateMessagesChars,
  estimatePromptUnitsForContextWindow,
  resolveContextCharsPerTokenUnit,
} from '../context/tokens.js';
import {
  shouldTriggerCompaction,
  shouldProactiveCompact,
  compactHistoryIfNeeded,
  type SummarizeFn,
} from '../context/compaction.js';
import { shouldProactiveCompactByWindowEconomics } from '../context/window-economics.js';
import { buildCompactionCheckpointOutline } from './compact-hooks.js';
import type { RemoteCompactProvider } from '../context/remote-compaction.js';

export function applyPreLlmContextOptimizations(
  messages: InternalMessage[],
  config: DmossAgentConfig,
): {
  messages: InternalMessage[];
  events: Array<{
    type: 'microcompact';
    compressedCount: number;
    savedChars: number;
    savedTokens: number;
  }>;
} {
  const events: Array<{
    type: 'microcompact';
    compressedCount: number;
    savedChars: number;
    savedTokens: number;
  }> = [];
  let current = messages;

  if (config.enableStaleReadInvalidation !== false) {
    const invalidated = invalidateStaleReadToolResults(toSessionMessages(current));
    current = invalidated.messages as unknown as InternalMessage[];
  }

  if (config.enableMicrocompact !== false) {
    const mc = microcompact(toSessionMessages(current), config.microcompactConfig);
    if (mc.compressedCount > 0) {
      current = mc.messages as unknown as InternalMessage[];
      events.push({
        type: 'microcompact',
        compressedCount: mc.compressedCount,
        savedChars: mc.savedChars,
        savedTokens: mc.savedTokens,
      });
    }
  }

  if (config.enableTailToolSnip !== false) {
    const snip = snipTailOversizedToolResults(
      toSessionMessages(current),
      config.tailToolSnipConfig,
    );
    if (snip.snippedCount > 0) {
      current = snip.messages as unknown as InternalMessage[];
    }
  }

  return { messages: current, events };
}

export function runPruning(
  messages: InternalMessage[],
  contextWindowTokens: number,
  systemPrompt: string,
  config: DmossAgentConfig,
): PruneResult {
  const rawTotalChars = estimateMessagesChars(toSessionMessages(messages)) + systemPrompt.length;
  const charsPerUnit = rawTotalChars / contextWindowTokens >= 0.85 ? 1 : resolveContextCharsPerTokenUnit();
  const systemPromptTokens = Math.ceil(
    estimatePromptUnitsForContextWindow({
      messages: [],
      systemPrompt,
      charsPerTokenUnit: charsPerUnit,
      effectiveContextWindowTokens: contextWindowTokens,
    }),
  );
  return pruneContextMessages({
    messages: toSessionMessages(messages),
    contextWindowTokens,
    systemPromptTokens,
    charsPerTokenUnit: charsPerUnit,
    settings: config.pruningSettings,
  });
}

export async function runCompactionIfNeeded(
  messages: InternalMessage[],
  contextWindowTokens: number,
  systemPrompt: string,
  provider: LLMProvider,
  remoteCompactProvider: RemoteCompactProvider | undefined,
  config: DmossAgentConfig,
  options?: { forceCompaction?: boolean },
): Promise<{
  messages: InternalMessage[];
  compacted: boolean;
  summaryChars: number;
  droppedMessages: number;
  checkpointOutline?: string[];
}> {
  const summarize: SummarizeFn = async (params) => {
    const resp = await provider.complete({
      model: config.model ?? 'claude-sonnet-4-20250514',
      systemPrompt: params.system,
      messages: [{ role: 'user', content: params.userPrompt }],
      maxTokens: params.maxTokens,
    });
    const text = resp.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return text;
  };

  const compactResult = await compactHistoryIfNeeded({
    summarize,
    messages: toSessionMessages(messages),
    contextWindowTokens,
    pruningSettings: config.pruningSettings,
    compactionSettings: config.compactionSettings,
    systemPrompt,
    charsPerTokenUnit: resolveContextCharsPerTokenUnit(),
    forceCompaction: options?.forceCompaction,
    remoteCompactProvider,
  });

  if (!compactResult.summary || !compactResult.summaryMessage) {
    if (compactResult.pruneResult.droppedMessages.length > 0) {
      return {
        messages: compactResult.pruneResult.messages as unknown as InternalMessage[],
        compacted: false,
        summaryChars: 0,
        droppedMessages: compactResult.pruneResult.droppedMessages.length,
      };
    }
    return { messages, compacted: false, summaryChars: 0, droppedMessages: 0 };
  }

  const newMessages: InternalMessage[] = [
    compactResult.summaryMessage as unknown as InternalMessage,
    ...(compactResult.pruneResult.messages as unknown as InternalMessage[]),
  ];

  return {
    messages: newMessages,
    compacted: true,
    summaryChars: compactResult.summary.length,
    droppedMessages: compactResult.pruneResult.droppedMessages.length,
    checkpointOutline: buildCompactionCheckpointOutline(compactResult.summary),
  };
}

export function shouldCompact(
  messages: InternalMessage[],
  contextWindowTokens: number,
  systemPrompt: string,
  config: DmossAgentConfig,
): boolean {
  const charsPerUnit = resolveContextCharsPerTokenUnit();
  const promptUnits = estimatePromptUnitsForContextWindow({
    messages: toSessionMessages(messages),
    systemPrompt,
    charsPerTokenUnit: charsPerUnit,
    effectiveContextWindowTokens: contextWindowTokens,
  });
  return (
    shouldProactiveCompactByWindowEconomics({
      estimatedPromptTokens: promptUnits,
      effectiveContextWindowTokens: contextWindowTokens,
    }) ||
    shouldTriggerCompaction({
      messages: toSessionMessages(messages),
      contextWindowTokens,
      settings: config.compactionSettings,
      systemPrompt,
      charsPerTokenUnit: charsPerUnit,
    }) ||
    shouldProactiveCompact({
      messages: toSessionMessages(messages),
      contextWindowTokens,
      settings: config.compactionSettings,
    })
  );
}
