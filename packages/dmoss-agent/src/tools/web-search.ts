/**
 * `web_search` — keyless-by-default web search tool for the Agent.
 *
 * Companion to `web_fetch` (see web-fetch.ts): where `web_fetch` retrieves a
 * *known* URL, `web_search` *discovers* URLs from a query — "search the web",
 * "find the official docs for X", "look up this error message".
 *
 * Design (mirrors web-fetch.ts):
 *   - Zero hard dependency beyond global `fetch` (Node 18+).
 *   - Pluggable backend: keyless **DuckDuckGo** by default; **Brave** when an
 *     API key is supplied; or a host-injected `search` function (e.g. a
 *     multi-engine backplane). Tool name + `query` input stay stable
 *     so consumers work regardless of backend.
 *   - Safe-by-default: per-call timeout, result cap, fixed provider host
 *     (the model's query is URL-encoded into a constant host — no SSRF surface).
 *   - Returns a compact, source-linked result list for the LLM to act on
 *     (typically followed by a `web_fetch` on the most relevant result).
 *
 * Intentionally **not**:
 *   - A crawler or browser — follow up with `web_fetch` to read a result.
 *   - A ranking engine — it returns the provider's order verbatim.
 */

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { getRootLogger } from '../logger.js';
import { DmossError, ErrorCode } from '../errors.js';

const log = getRootLogger().child('tool:web-search');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 20;
/** Browser-like UA: public search endpoints reject the default agent UA. Overridable. */
const DEFAULT_UA =
  'Mozilla/5.0 (compatible; dmoss-agent/0.1; +https://github.com/D-Moss)';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBackendOptions {
  maxResults: number;
  timeoutMs: number;
  signal?: AbortSignal;
  region?: string;
  userAgent: string;
}

/** A pluggable search backend. Receives the raw query, returns ranked results. */
export type WebSearchBackend = (
  query: string,
  opts: WebSearchBackendOptions,
) => Promise<WebSearchResult[]>;

export interface WebSearchOptions {
  /**
   * Custom backend. Takes precedence over `provider`. Use this to route to a
   * proprietary search API or a multi-engine backplane.
   */
  search?: WebSearchBackend;
  /** Built-in provider when `search` is not supplied. Default: `duckduckgo`. */
  provider?: 'duckduckgo' | 'brave';
  /** API key for providers that need one (brave). Falls back to `BRAVE_API_KEY`. */
  apiKey?: string;
  /** Default max results (capped at 20). Default 8. */
  maxResults?: number;
  /** Per-call timeout in ms. Default 15 000. */
  timeoutMs?: number;
  /** Region / locale hint, e.g. `wt-wt` (DDG) or `zh-CN` (Brave). */
  region?: string;
  /** Custom User-Agent. */
  userAgent?: string;
}

function coerceString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return String(v);
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = HTML_ENTITIES[entity];
    if (known !== undefined) return known;
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * DuckDuckGo wraps result links in a `/l/?uddg=<encoded-target>` redirect.
 * Unwrap it so the LLM gets a directly fetchable URL.
 */
function unwrapDuckDuckGoHref(href: string): string {
  const normalized = href.startsWith('//') ? `https:${href}` : href;
  try {
    const u = new URL(normalized, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      return normalized; // redirect we couldn't decode — return as-is
    }
    return u.toString();
  } catch {
    return normalized;
  }
}

interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<FetchTextResult> {
  // An already-aborted signal must not issue a fetch: addEventListener('abort')
  // below never fires if the signal aborted before the listener was attached.
  if (outerSignal?.aborted) {
    throw new DmossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    if (outerSignal?.aborted) {
      throw new DmossError({ code: ErrorCode.USER_ABORTED, message: 'web_search aborted' });
    }
    if (controller.signal.aborted) {
      throw new DmossError({
        code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
        message: `web_search: provider timed out after ${timeoutMs}ms`,
        recoverable: true,
      });
    }
    throw new DmossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: provider request failed: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: true,
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

/** Keyless DuckDuckGo HTML-endpoint backend. */
export async function duckDuckGoSearch(
  query: string,
  opts: WebSearchBackendOptions,
): Promise<WebSearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: opts.region || 'wt-wt' });
  const { ok, status, text } = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': opts.userAgent,
        accept: 'text/html',
      },
      body: body.toString(),
    },
    opts.timeoutMs,
    opts.signal,
  );

  if (!ok) {
    throw new DmossError({
      code: status === 429 ? ErrorCode.PROVIDER_RATE_LIMITED : ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `web_search: DuckDuckGo returned HTTP ${status}`,
      hint:
        status === 429
          ? 'Rate-limited by DuckDuckGo. Retry shortly, or configure a Brave API key (provider: "brave").'
          : undefined,
      recoverable: true,
    });
  }

  const results: WebSearchResult[] = [];
  // Each result is a `result__a` anchor (title + href); the following
  // `result__snippet` (anchor or div) holds the description.
  const linkRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(text)) !== null) snippets.push(stripTags(sm[1]));

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(text)) !== null && results.length < opts.maxResults) {
    const url = unwrapDuckDuckGoHref(lm[1]);
    const title = stripTags(lm[2]);
    if (!title || !/^https?:\/\//i.test(url)) {
      i++;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
  }
  if (results.length === 0 && duckDuckGoResponseLooksBlocked(text)) {
    // DuckDuckGo's keyless HTML endpoint increasingly serves an anti-bot
    // "anomaly"/challenge page (HTTP 200, no result markup). Reporting that as
    // "No results" misleads the model into thinking the topic has no information
    // (a confabulation hazard) and makes it retry the same dead query. Tell the truth.
    throw new DmossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message:
        'web_search: DuckDuckGo blocked automated access (anti-bot/anomaly page) — no results could be retrieved. This is a backend failure, NOT an empty result set; do not infer the topic has no information.',
      hint:
        'Configure a Brave API key (set BRAVE_API_KEY or pass provider: "brave") for reliable search, or call web_fetch on a specific known URL instead.',
      recoverable: true,
    });
  }
  return results;
}

/**
 * Given DuckDuckGo's HTML response body that yielded zero parsed results, decide
 * whether the backend is blocked/broken (anti-bot/anomaly page, or no result markup
 * at all) vs a genuinely empty result set. Exported for testing.
 */
export function duckDuckGoResponseLooksBlocked(text: string): boolean {
  const looksBlocked =
    /anomaly|challenge-form|captcha|unusual traffic|detected unusual|are you a (?:human|robot)/i.test(text);
  const hasResultMarkup = /result__a|result__snippet|no-results|results_links/i.test(text);
  return looksBlocked || !hasResultMarkup;
}

/** Brave Search API backend (requires an API key). */
export function createBraveSearch(apiKey: string): WebSearchBackend {
  return async (query, opts) => {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(opts.maxResults));
    if (opts.region) u.searchParams.set('country', opts.region);
    const { ok, status, text } = await fetchWithTimeout(
      u.toString(),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': opts.userAgent,
          'x-subscription-token': apiKey,
        },
      },
      opts.timeoutMs,
      opts.signal,
    );
    if (!ok) {
      throw new DmossError({
        code:
          status === 401 || status === 403
            ? ErrorCode.PROVIDER_AUTH_FAILED
            : status === 429
              ? ErrorCode.PROVIDER_RATE_LIMITED
              : ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: `web_search: Brave returned HTTP ${status}`,
        recoverable: status === 429 || status >= 500,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DmossError({
        code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
        message: 'web_search: Brave returned non-JSON response',
        recoverable: true,
      });
    }
    const rows = (json as { web?: { results?: unknown[] } })?.web?.results ?? [];
    const results: WebSearchResult[] = [];
    for (const row of rows) {
      const r = row as { title?: unknown; url?: unknown; description?: unknown };
      const url = coerceString(r.url);
      if (!/^https?:\/\//i.test(url)) continue;
      results.push({
        title: stripTags(coerceString(r.title)) || url,
        url,
        snippet: stripTags(coerceString(r.description)),
      });
      if (results.length >= opts.maxResults) break;
    }
    return results;
  };
}

function resolveBackend(opts: WebSearchOptions): WebSearchBackend {
  if (opts.search) return opts.search;
  const provider = opts.provider ?? 'duckduckgo';
  if (provider === 'brave') {
    const key = opts.apiKey ?? process.env.BRAVE_API_KEY;
    if (!key) {
      throw new DmossError({
        code: ErrorCode.PROVIDER_CONFIG_MISSING,
        message: 'web_search: Brave provider selected but no API key',
        hint: 'Pass `apiKey` to createWebSearchTool or set BRAVE_API_KEY.',
        recoverable: false,
      });
    }
    return createBraveSearch(key);
  }
  return duckDuckGoSearch;
}

function formatResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return (
      `No results for "${query}". ` +
      'Try different keywords, drop ambiguous terms, or call web_fetch on a known URL instead.'
    );
  }
  const lines = results.map((r, idx) => {
    const snippet = r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : '';
    return `${idx + 1}. ${r.title}\n   ${r.url}${snippet}`;
  });
  return `Found ${results.length} result(s) for "${query}":\n\n${lines.join('\n\n')}`;
}

export function createWebSearchTool(opts: WebSearchOptions = {}): Tool<{ query: string; max_results?: number }> {
  const defaultMax = Math.min(Math.max(1, opts.maxResults ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const userAgent = opts.userAgent ?? DEFAULT_UA;
  const region = opts.region;
  // Resolve eagerly so a misconfigured Brave key surfaces at registration in
  // tests, but tolerate it at construction time for the default keyless path.
  const backend = resolveBackend(opts);

  return {
    name: 'web_search',
    description:
      'Search the web and return a ranked list of results (title, URL, snippet). ' +
      'Use this to discover official documentation, look up an error message, or find a page when you do not know its URL. ' +
      'Follow up with web_fetch on the most relevant result to read its contents.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      permissionBoundary:
        'Performs an outbound HTTP(S) query to a fixed search provider; the model query is URL-encoded (no SSRF surface).',
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — keywords, a question, or a verbatim error message.',
        },
        max_results: {
          type: 'number',
          description: `Maximum results to return (default ${defaultMax}, max ${MAX_RESULTS_CAP}).`,
        },
      },
      required: ['query'],
    },
    async execute(input, ctx: ToolContext) {
      const query = coerceString(input?.query).trim();
      if (!query) {
        throw new DmossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: 'web_search: query is required',
          hint: 'Pass a non-empty `query`, e.g. "RDK X5 BPU model conversion docs".',
          recoverable: false,
        });
      }
      const maxResults = Math.min(
        Math.max(1, Number(input?.max_results) || defaultMax),
        MAX_RESULTS_CAP,
      );

      log.debug('start', { query, maxResults, provider: opts.provider ?? 'duckduckgo' });
      const started = Date.now();
      const results = await backend(query, {
        maxResults,
        timeoutMs,
        signal: ctx.abortSignal,
        region,
        userAgent,
      });
      log.debug('done', { query, count: results.length, ms: Date.now() - started });
      return formatResults(query, results.slice(0, maxResults));
    },
  };
}
