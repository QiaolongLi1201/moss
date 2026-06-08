/**
 * Remote Compaction Provider.
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

import type { Message } from '../core/session/session-jsonl.js';
import { createCompactionSummaryMessage } from '../core/session/session-jsonl.js';
import { estimateMessagesTokens } from './tokens.js';
import {
  buildCompactionSummary,
  type SummarizeFn,
  DEFAULT_COMPACTION_SETTINGS,
} from './compaction.js';
import { getRootLogger } from '../logger.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { DmossError, ErrorCode } from '../errors.js';

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
  abortSignal?: AbortSignal;
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
  abortSignal?: AbortSignal;
}

function redactSecretsInText(text: string): string {
  return sanitizeSecrets(text);
}

function sanitizeTextForRemote(value: string | undefined): string | undefined {
  return typeof value === 'string' ? redactSecretsInText(value) : undefined;
}

function sanitizePayloadForRemote(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { ...msg, content: redactSecretsInText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((block) => {
          if (block.type === 'text' && block.text) {
            return { ...block, text: redactSecretsInText(block.text) };
          }
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            return { ...block, content: redactSecretsInText(block.content) };
          }
          return block;
        }),
      };
    }
    return msg;
  });
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

    // C3: Enforce HTTPS for non-localhost endpoints
    const isLocalhost = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(this.compactUrl);
    if (!isLocalhost && !this.compactUrl.startsWith('https://')) {
      throw new DmossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'Remote compaction endpoint must use HTTPS for non-localhost URLs. ' +
          'Set DMOSS_REMOTE_COMPACT_ENDPOINT to an https:// URL, or use localhost for development.',
      });
    }

    // C3: Require auth for non-localhost endpoints
    if (!isLocalhost && !this.apiKey) {
      throw new DmossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'Remote compaction endpoint requires an API key for non-localhost URLs. ' +
          'Set DMOSS_REMOTE_COMPACT_API_KEY.',
      });
    }
  }

  async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(this.healthUrl, {
        signal: controller.signal,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async compact(request: RemoteCompactRequest): Promise<RemoteCompactResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = request.abortSignal
      ? AbortSignal.any([controller.signal, request.abortSignal])
      : controller.signal;

    try {
      const res = await fetch(this.compactUrl, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          messages: sanitizePayloadForRemote(request.messages),
          system_prompt: sanitizeTextForRemote(request.systemPrompt),
          max_output_tokens: request.maxOutputTokens,
          context_window_tokens: request.contextWindowTokens,
          model: request.model,
          custom_instructions: sanitizeTextForRemote(request.customInstructions),
        }),
      });

      if (!res.ok) {
        throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: `Remote compact failed: ${res.status} ${res.statusText}` });
      }

      // Bound response body size — streaming read to handle chunked transfer
      const MAX_BODY_BYTES = 10 * 1024 * 1024;
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
        throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'Remote compact response too large' });
      }

      let bodyText: string;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_BODY_BYTES) {
            reader.cancel();
            throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'Remote compact response too large' });
          }
          chunks.push(value);
        }
        const body = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        bodyText = new TextDecoder().decode(body);
      } else {
        bodyText = await res.text();
      }

      const data = JSON.parse(bodyText) as {
        summary?: string;
        compacted_messages?: Message[];
        tokens_saved?: number;
      };

      // Validate remote response
      const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
      if (!summary) {
        throw new DmossError({ code: ErrorCode.PROVIDER_UPSTREAM_ERROR, message: 'Remote compact returned empty summary' });
      }

      const tokensSaved = typeof data.tokens_saved === 'number' && data.tokens_saved >= 0
        ? data.tokens_saved
        : 0;

      let compactedMessages: Message[] | undefined;
      if (data.compacted_messages !== undefined) {
        if (!Array.isArray(data.compacted_messages)) {
          log.warn('remote compact returned non-array compacted_messages; ignoring', {
            type: typeof data.compacted_messages,
          });
        } else {
          compactedMessages = data.compacted_messages as Message[];
        }
      }

      return {
        summary,
        compactedMessages,
        tokensSaved,
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
          abortSignal: config.abortSignal,
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
      // If the abort signal was triggered, don't fall back to local compaction.
      // The caller has cancelled the operation and we should respect that.
      if (config.abortSignal?.aborted) {
        log.info('remote compaction aborted, not falling back to local');
        throw err;
      }
      log.warn('remote compaction failed, falling back to local', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Check abort signal again before starting local compaction
  if (config.abortSignal?.aborted) {
    throw new Error('compaction aborted before local fallback');
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
