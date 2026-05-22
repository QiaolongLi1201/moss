/**
 * Remote Compaction Provider (aligned with Codex /responses/compact strategy)
 *
 * Instead of doing LLM summarization client-side (which consumes tokens and
 * is slower), this module supports delegating compaction to a remote endpoint
 * that can perform server-side compression more efficiently.
 *
 * Design:
 * - RemoteCompactProvider interface allows plugging in different backends
 * - Built-in LLM-based fallback when remote is unavailable
 * - Hybrid mode: try remote first, fall back to local summarization
 * - Token budget awareness: remote endpoint receives budget constraints
 */

import type { Message } from '../core/session-jsonl.js';
import { createCompactionSummaryMessage } from '../core/session-jsonl.js';
import { estimateMessagesTokens } from './tokens.js';
import {
  buildCompactionSummary,
  type SummarizeFn,
  DEFAULT_COMPACTION_SETTINGS,
} from './compaction.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:remote-compact');

/**
 * Normalize a configured base URL to match the remote compaction routes:
 * - POST `{base}/compact`
 * - GET `{base}/compact/health`
 *
 * Accepts either `http://host/api/d-moss` or `http://host/api/d-moss/compact`.
 */
export function resolveRemoteCompactUrls(endpoint: string): { compactUrl: string; healthUrl: string } {
  const base = endpoint.trim().replace(/\/+$/, '');
  const compactUrl = base.endsWith('/compact') ? base : `${base}/compact`;
  return { compactUrl, healthUrl: `${compactUrl}/health` };
}

export interface RemoteCompactRequest {
  messages: Message[];
  systemPrompt?: string;
  maxOutputTokens: number;
  contextWindowTokens: number;
  model?: string;
  customInstructions?: string;
}

export interface RemoteCompactResponse {
  summary: string;
  compactedMessages?: Message[];
  tokensSaved: number;
  method: 'remote' | 'local_fallback';
}

export interface RemoteCompactProvider {
  compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse>;
  isAvailable(): Promise<boolean>;
}

export interface HybridCompactionConfig {
  remoteProvider?: RemoteCompactProvider;
  localSummarize: SummarizeFn;
  contextWindowTokens: number;
  reserveTokens?: number;
  customInstructions?: string;
}

/**
 * HTTP-based remote compaction provider.
 * Sends conversation to a server endpoint for efficient server-side compression.
 */
export class HttpRemoteCompactProvider implements RemoteCompactProvider {
  private readonly compactUrl: string;
  private readonly healthUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(params: {
    endpoint: string;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    const urls = resolveRemoteCompactUrls(params.endpoint);
    this.compactUrl = urls.compactUrl;
    this.healthUrl = urls.healthUrl;
    this.apiKey = params.apiKey;
    this.timeoutMs = params.timeoutMs ?? 60_000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(this.healthUrl, {
        signal: controller.signal,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.compactUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          messages: request.messages,
          system_prompt: request.systemPrompt,
          max_output_tokens: request.maxOutputTokens,
          context_window_tokens: request.contextWindowTokens,
          model: request.model,
          custom_instructions: request.customInstructions,
        }),
      });

      if (!res.ok) {
        throw new Error(`Remote compact failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as {
        summary?: string;
        compacted_messages?: Message[];
        tokens_saved?: number;
      };

      return {
        summary: data.summary ?? '',
        compactedMessages: data.compacted_messages,
        tokensSaved: data.tokens_saved ?? 0,
        method: 'remote',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Hybrid compaction: tries remote first, falls back to local LLM summarization.
 *
 * This is the recommended usage pattern:
 * - Fast path: remote endpoint handles compaction (< 2s typically)
 * - Fallback: local LLM summarization (10-30s depending on context size)
 */
export async function hybridCompact(
  config: HybridCompactionConfig,
  messages: Message[],
  systemPrompt?: string,
): Promise<{
  summary: string;
  summaryMessage: Message;
  method: 'remote' | 'local_fallback' | 'local_only';
  tokensSaved: number;
}> {
  const reserveTokens = config.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxOutputTokens = Math.max(64, Math.floor(0.8 * reserveTokens));
  const inputTokens = estimateMessagesTokens(messages);

  if (config.remoteProvider) {
    try {
      const available = await config.remoteProvider.isAvailable();
      if (available) {
        const result = await config.remoteProvider.compact({
          messages,
          systemPrompt,
          maxOutputTokens,
          contextWindowTokens: config.contextWindowTokens,
          customInstructions: config.customInstructions,
        });

        if (result.summary) {
          const summaryMessage = createCompactionSummaryMessage(result.summary, Date.now());
          log.info('remote compaction succeeded', {
            inputTokens,
            tokensSaved: result.tokensSaved,
            summaryLength: result.summary.length,
          });
          return {
            summary: result.summary,
            summaryMessage,
            method: 'remote',
            tokensSaved: result.tokensSaved,
          };
        }
      }
    } catch (err) {
      log.warn('remote compaction failed, falling back to local', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = await buildCompactionSummary({
    summarize: config.localSummarize,
    messages,
    contextWindowTokens: config.contextWindowTokens,
    maxTokens: maxOutputTokens,
    reserveTokens,
    customInstructions: config.customInstructions,
  });

  const summaryTokens = Math.ceil(summary.length / 4);
  const tokensSaved = Math.max(0, inputTokens - summaryTokens);
  const summaryMessage = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    method: config.remoteProvider ? 'local_fallback' : 'local_only',
    tokensSaved,
  };
}

/**
 * Create a remote compaction provider from environment configuration.
 * Returns undefined if no remote endpoint is configured.
 *
 * `DMOSS_REMOTE_COMPACT_ENDPOINT`: base URL **without** trailing slash. Either:
 * - `http://127.0.0.1:5174/api/d-moss` → POST `/api/d-moss/compact`, GET `/api/d-moss/compact/health`
 * - or already suffixed with `/compact` (same effective URLs).
 */
export function createRemoteCompactProviderFromEnv(): RemoteCompactProvider | undefined {
  const endpoint = process.env.DMOSS_REMOTE_COMPACT_ENDPOINT?.trim();
  if (!endpoint) return undefined;

  return new HttpRemoteCompactProvider({
    endpoint,
    apiKey: process.env.DMOSS_REMOTE_COMPACT_API_KEY?.trim(),
    timeoutMs: Number(process.env.DMOSS_REMOTE_COMPACT_TIMEOUT_MS) || 60_000,
  });
}
