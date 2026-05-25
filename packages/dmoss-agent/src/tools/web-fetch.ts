/**
 * `web_fetch` — generic HTTP(S) fetch tool for the Agent.
 *
 * Goals:
 *   - Zero dependency beyond `fetch` (Node 18+).
 *   - Safe-by-default: HTTP(S) only, size cap, timeout, optional private-IP block.
 *   - HTML → readable text via a minimal cleaner (strips <script> / <style> and tags).
 *   - Logs via `@dmoss/agent/logger` (scope: `tool:web-fetch`) with sensitive-field redaction.
 *
 * Intentionally **not**:
 *   - A browser / JS renderer (use `playwright` elsewhere if needed).
 *   - A full scraper (depth/recursion handled by callers).
 *   - A search engine — see `web-search.ts` for a separate tool.
 */

import dns from 'node:dns/promises';
import type { Tool, ToolContext } from '../core/tool-types.js';
import { getRootLogger } from '../logger.js';
import { DmossError, ErrorCode } from '../errors.js';

const log = getRootLogger().child('tool:web-fetch');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TEXT_CHARS = 16_000;
/** DNS resolution timeout for SSRF check (ms). Prevents unbounded latency on slow/unreachable resolvers. */
const DNS_CHECK_TIMEOUT_MS = 3_000;
/** DNS result cache TTL (ms). Avoids repeated lookups for the same host within an agent session. */
const DNS_CACHE_TTL_MS = 60_000;

const dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>();

export interface WebFetchOptions {
  /** Per-tool-call upper bound on response body size in bytes (post-HTTP, pre-decode). Default 1 MB. */
  maxBytes?: number;
  /** Per-tool-call upper bound on returned text length (chars) after HTML cleanup. Default 16 000. */
  maxTextChars?: number;
  /** Per-tool-call fetch timeout in milliseconds. Default 20 000. */
  timeoutMs?: number;
  /** Block requests to private / loopback / link-local / metadata IPs (SSRF防护). Default true. */
  blockPrivateNetwork?: boolean;
  /** Allowlist of hosts (lowercased, supports `*.domain` suffix match). If set, everything else is rejected. */
  allowHosts?: string[];
  /** Custom User-Agent. Default: `dmoss-agent/<version>`. */
  userAgent?: string;
}

const PRIVATE_IP_RES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

async function isPrivateHost(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (h === '0.0.0.0') return true;
  if (PRIVATE_IP_RES.some((re) => re.test(h))) return true;
  // Resolve DNS with timeout and cache to prevent DNS rebinding attacks
  // without adding unbounded latency to web_fetch tool calls.
  try {
    const now = Date.now();
    let addresses: string[];
    const cached = dnsCache.get(h);
    if (cached && cached.expiresAt > now) {
      addresses = cached.addresses;
    } else {
      addresses = await Promise.race([
        dns.resolve4(h),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('dns timeout')), DNS_CHECK_TIMEOUT_MS),
        ),
      ]);
      dnsCache.set(h, { addresses, expiresAt: now + DNS_CACHE_TTL_MS });
    }
    for (const ip of addresses) {
      if (PRIVATE_IP_RES.some((re) => re.test(ip))) return true;
    }
  } catch {
    // DNS resolution failed or timed out — treat as non-private (can't verify)
  }
  return false;
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return false;
}

/** Very small HTML → text cleanup (no jsdom dependency). */
function htmlToText(html: string, maxChars: number): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|header|footer|nav)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n… (truncated, original length ${out.length} chars)`;
  }
  return out;
}

function coerceString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return fallback;
  return String(v);
}

export function createWebFetchTool(opts: WebFetchOptions = {}): Tool<{ url: string }> {
  const maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxTextChars = Math.max(256, opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const blockPrivate = opts.blockPrivateNetwork !== false;
  const userAgent = opts.userAgent ?? 'dmoss-agent/0.1 (+https://github.com/D-Moss)';
  const allowHosts = (opts.allowHosts ?? []).map((s) => s.toLowerCase());

  return {
    name: 'web_fetch',
    description:
      'Fetch an http(s) URL and return a readable text extract of the page. ' +
      'Useful when you need the content of a documentation / API reference / status page. ' +
      'Blocks private / loopback / link-local addresses by default (anti-SSRF). ' +
      'Truncates very large bodies. For live JS apps, prefer a headless browser tool.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
      },
      required: ['url'],
    },
    async execute(input, ctx: ToolContext) {
      const raw = coerceString(input?.url).trim();
      if (!raw) {
        throw new DmossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: 'web_fetch: url is required',
          hint: 'Pass an absolute http(s) URL, e.g. https://example.com/',
          recoverable: false,
        });
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new DmossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: `web_fetch: invalid URL "${raw}"`,
          hint: 'Provide an absolute http(s) URL; relative paths are not supported.',
          recoverable: false,
        });
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new DmossError({
          code: ErrorCode.USER_INPUT_INVALID,
          message: `web_fetch: unsupported protocol ${url.protocol}`,
          hint: 'Only http: and https: are allowed. For local files use read/readFile tools.',
          recoverable: false,
        });
      }
      if (allowHosts.length > 0 && !allowHosts.some((p) => hostMatches(url.hostname, p))) {
        throw new DmossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `web_fetch: host "${url.hostname}" is not in the allowlist`,
          hint: 'Add the host to allowHosts when creating the tool, or use a different URL.',
          recoverable: false,
        });
      }
      if (blockPrivate && await isPrivateHost(url.hostname)) {
        throw new DmossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `web_fetch: refused to connect to private host "${url.hostname}"`,
          hint:
            'Private/loopback/link-local IPs are blocked by default (SSRF protection). ' +
            'If you really need this (e.g. a trusted device), create the tool with `blockPrivateNetwork: false`.',
          recoverable: false,
        });
      }

      const controller = new AbortController();
      const mergedSignal = ctx.abortSignal
        ? anySignal(ctx.abortSignal, controller.signal)
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      log.debug('start', { url: url.toString(), maxBytes, timeoutMs });
      const started = Date.now();
      try {
        let currentUrl = url;
        let res: Response;
        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        // Manual redirect following so we can re-check SSRF policy at each hop
        for (;;) {
          res = await fetch(currentUrl.toString(), {
            signal: mergedSignal,
            headers: {
              'User-Agent': userAgent,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            },
            redirect: 'manual',
          });
          if (res.status >= 300 && res.status < 400 && redirectCount < MAX_REDIRECTS) {
            const location = res.headers.get('location');
            if (!location) break;
            let nextUrl: URL;
            try {
              nextUrl = new URL(location, currentUrl);
            } catch {
              break;
            }
            redirectCount++;
            if (blockPrivate && await isPrivateHost(nextUrl.hostname)) {
              res.body?.cancel?.();
              throw new DmossError({
                code: ErrorCode.TOOL_NOT_ALLOWED,
                message: `web_fetch: redirect to private host "${nextUrl.hostname}" blocked (SSRF protection)`,
                hint: 'The target server redirected to a private/internal address.',
                recoverable: false,
              });
            }
            if (allowHosts.length > 0 && !allowHosts.some((p) => hostMatches(nextUrl.hostname, p))) {
              res.body?.cancel?.();
              throw new DmossError({
                code: ErrorCode.TOOL_NOT_ALLOWED,
                message: `web_fetch: redirect to "${nextUrl.hostname}" not in allowlist`,
                hint: 'Add the host to allowHosts when creating the tool.',
                recoverable: false,
              });
            }
            res.body?.cancel?.();
            currentUrl = nextUrl;
            continue;
          }
          break;
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!res.ok) {
          log.warn('non-2xx response', { url: url.toString(), status: res.status });
          return `web_fetch_error: HTTP ${res.status} ${res.statusText} — ${url.toString()}`;
        }
        /**
         * Read body into Buffer but cap by maxBytes to avoid memory blow-up on huge pages.
         * Using `arrayBuffer` with streaming would be more memory-efficient but requires ReadableStream;
         * typical docs pages are well under 1 MB so this is acceptable.
         */
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        const truncated = buf.length > maxBytes;
        const body = truncated ? buf.subarray(0, maxBytes) : buf;
        const isJson = contentType.includes('application/json');
        const isText = contentType.startsWith('text/') || isJson || contentType.includes('xml');
        let out: string;
        if (isJson) {
          try {
            const parsed = JSON.parse(body.toString('utf-8'));
            out = JSON.stringify(parsed, null, 2);
          } catch {
            out = body.toString('utf-8');
          }
        } else if (isText) {
          const text = body.toString('utf-8');
          out = contentType.includes('html') ? htmlToText(text, maxTextChars) : text.slice(0, maxTextChars);
        } else {
          out = `web_fetch_ok: ${buf.length} bytes, binary content-type=${contentType || 'unknown'}; not returning binary data as text.`;
        }
        if (out.length > maxTextChars) {
          out = out.slice(0, maxTextChars) + `\n\n… (truncated at ${maxTextChars} chars)`;
        }
        const elapsed = Date.now() - started;
        log.debug('ok', {
          url: url.toString(),
          status: res.status,
          bytes: buf.length,
          outChars: out.length,
          truncatedBytes: truncated,
          elapsedMs: elapsed,
        });
        const header = `web_fetch_ok: ${url.toString()} · HTTP ${res.status} · ${buf.length}B${truncated ? ' (body truncated)' : ''} · ${elapsed}ms\n`;
        return header + '\n' + out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((err as { name?: string })?.name === 'AbortError') {
          throw new DmossError({
            code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
            message: `web_fetch: timed out or aborted after ${timeoutMs}ms`,
            hint: 'Increase timeoutMs when creating the tool, or ensure the target is reachable.',
            recoverable: true,
            context: { url: url.toString(), timeoutMs },
          });
        }
        throw new DmossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `web_fetch: ${msg}`,
          hint: 'Check the URL, network connectivity, and host reachability.',
          recoverable: true,
          cause: err,
          context: { url: url.toString() },
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Minimal AbortSignal.any polyfill (combine two signals). Node ≥ 19 has AbortSignal.any natively.
 */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const on = () => {
    ctrl.abort();
    a.removeEventListener('abort', on);
    b.removeEventListener('abort', on);
  };
  a.addEventListener('abort', on, { once: true });
  b.addEventListener('abort', on, { once: true });
  return ctrl.signal;
}
