import {
  compactHistoryIfNeeded,
  type CompactionSettings,
  type SummarizeFn,
} from '../../context/compaction.js';
import type { ContextPruningSettings, PruneResult } from '../../context/pruning.js';
import type { LLMProvider } from './llm-provider.js';
import type { Message } from '../session/session-jsonl.js';

export type SummarizationStrategyKind = 'client_llm' | 'provider_server_compaction';

export type SummarizationStrategyInput = {
  messages: Message[];
  contextWindowTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactionSettings?: Partial<CompactionSettings>;
  systemPrompt?: string;
  charsPerTokenUnit?: number;
  maxTokens?: number;
  skipLlmCompaction?: boolean;
  forceCompaction?: boolean;
  abortSignal?: AbortSignal;
};

export type ProviderServerCompactionPayload = {
  /**
   * Matches provider-side compaction APIs that return an opaque checkpoint
   * instead of a plain-text summary.
   */
  encryptedContent?: string;
  /** Provider-native replacement input, if the adapter can expose it safely. */
  input?: unknown;
  /** Raw provider response for a future integration layer to interpret. */
  raw?: unknown;
};

export type SummarizationStrategyResult =
  | {
      kind: 'none';
      source: SummarizationStrategyKind;
      pruneResult?: PruneResult;
    }
  | {
      kind: 'client_summary';
      source: 'client_llm';
      summary: string;
      summaryMessage: Message;
      pruneResult: PruneResult;
    }
  | {
      kind: 'provider_compaction';
      source: 'provider_server_compaction';
      compaction: ProviderServerCompactionPayload;
      pruneResult?: PruneResult;
    };

export interface SummarizationStrategy {
  readonly id: string;
  readonly kind: SummarizationStrategyKind;
  compact(input: SummarizationStrategyInput): Promise<SummarizationStrategyResult>;
}

export function createSummarizeFnFromLlmProvider(params: {
  provider: Pick<LLMProvider, 'complete'>;
  model: string;
}): SummarizeFn {
  return async (request) => {
    const response = await params.provider.complete({
      model: params.model,
      systemPrompt: request.system,
      messages: [{ role: 'user', content: request.userPrompt }],
      maxTokens: request.maxTokens,
    });
    return response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');
  };
}

export function createClientLlmSummarizationStrategy(params: {
  summarize: SummarizeFn;
  id?: string;
}): SummarizationStrategy {
  return {
    id: params.id ?? 'client_llm',
    kind: 'client_llm',
    async compact(input) {
      const result = await compactHistoryIfNeeded({
        summarize: params.summarize,
        messages: input.messages,
        contextWindowTokens: input.contextWindowTokens,
        pruningSettings: input.pruningSettings,
        compactionSettings: input.compactionSettings,
        systemPrompt: input.systemPrompt,
        charsPerTokenUnit: input.charsPerTokenUnit,
        maxTokens: input.maxTokens,
        skipLlmCompaction: input.skipLlmCompaction,
        forceCompaction: input.forceCompaction,
      });

      if (result.summary && result.summaryMessage) {
        return {
          kind: 'client_summary',
          source: 'client_llm',
          summary: result.summary,
          summaryMessage: result.summaryMessage,
          pruneResult: result.pruneResult,
        };
      }

      return {
        kind: 'none',
        source: 'client_llm',
        pruneResult: result.pruneResult,
      };
    },
  };
}

export type ProviderServerCompactionFn = (
  input: SummarizationStrategyInput,
) => Promise<ProviderServerCompactionPayload | null | undefined>;

export function createProviderServerCompactionStrategy(params: {
  compact: ProviderServerCompactionFn;
  id?: string;
}): SummarizationStrategy {
  return {
    id: params.id ?? 'provider_server_compaction',
    kind: 'provider_server_compaction',
    async compact(input) {
      const compaction = await params.compact(input);
      if (!compaction) {
        return {
          kind: 'none',
          source: 'provider_server_compaction',
        };
      }
      return {
        kind: 'provider_compaction',
        source: 'provider_server_compaction',
        compaction,
      };
    },
  };
}
