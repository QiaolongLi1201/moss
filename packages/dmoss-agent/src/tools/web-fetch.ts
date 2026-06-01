/**
 * `web_fetch` — generic HTTP(S) fetch tool for the Agent.
 *
 * Goals:
 *   - Zero dependency beyond `fetch` (Node 18+).
 *   - Safe-by-default: HTTP(S) only, size cap, timeout, optional private-IP block.
 *   - HTML → readable text via a minimal cleaner (strips <script> / <style> and tags).
 *   - Logs via `@rdk-moss/agent/logger` (scope: `tool:web-fetch`) with sensitive-field redaction.
 *
 * Intentionally **not**:
 *   - A browser / JS renderer (use `playwright` elsewhere if needed).
 *   - A full scraper (depth/recursion handled by callers).
 *   - A search engine — see `web-search.ts` for a separate tool.
 */

import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { getRootLogger } from '../logger.js';
import { DmossError, ErrorCode } from '../errors.js';

const log = getRootLogger().child('tool:web-fetch');

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_TEXT_CHARS = 16_000;
const BODY_CAP_PROBE_TIMEOUT_MS = 100;
/** DNS resolution timeout for SSRF check (ms). Prevents unbounded latency on slow/unreachable resolvers. */
const DNS_CHECK_TIMEOUT_MS = 3_000;
/** DNS result cache TTL (ms). Avoids repeated lookups for the same host within an agent session. */
const DNS_CACHE_TTL_MS = 60_000;

const dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>();
type HostAddressResolver = (hostname: string) => Promise<string[]>;
type BodyProbeReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
};
type ClosableDispatcher = { close?: () => Promise<void> | void };

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
  /** Optional resolver override for tests or embedded hosts. */
  resolveHostAddresses?: HostAddressResolver;
}

const PRIVATE_IP_RES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/i,
  /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.|0\.)/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

async function resolveHostAddressesWithTimeout(hostname: string, resolver: HostAddressResolver): Promise<string[]> {
  return Promise.race([
    resolver(hostname),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new DmossError({ code: ErrorCode.TOOL_EXECUTION_TIMEOUT, message: 'dns timeout' })), DNS_CHECK_TIMEOUT_MS),
    ),
  ]);
}

function ipFamily(address: string): 4 | 6 {
  return address.includes(':') ? 6 : 4;
}

async function createPinnedHttpsDispatcher(address: string): Promise<ClosableDispatcher> {
  let Agent: typeof import('undici').Agent;
  try {
    ({ Agent } = await import('undici'));
  } catch (err) {
    throw new DmossError({
      code: ErrorCode.TOOL_NOT_ALLOWED,
      message: 'web_fetch: unable to enforce HTTPS DNS pinning because undici is unavailable',
      hint:
        'Install the optional undici peer dependency, or create the tool with blockPrivateNetwork: false only for trusted URLs.',
      recoverable: false,
      cause: err,
    });
  }

  const family = ipFamily(address);
  type PinnedLookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;
  const lookup = ((
    _hostname: string,
    optionsOrCallback: { all?: boolean } | PinnedLookupCallback,
    callback?: PinnedLookupCallback,
  ) => {
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!cb) return;
    if (typeof optionsOrCallback === 'function') {
      cb(null, address, family);
      return;
    }
    const wantsAll = Boolean(optionsOrCallback?.all);
    if (wantsAll) {
      cb(null, [{ address, family } satisfies LookupAddress]);
      return;
    }
    cb(null, address, family);
  }) as LookupFunction;

  return new Agent({ connect: { lookup } });
}

async function closeDispatcher(dispatcher: ClosableDispatcher): Promise<void> {
  try {
    await dispatcher.close?.();
  } catch {
    /* best-effort cleanup */
  }
}

export async function resolveHostIp(
  hostname: string,
  resolver: HostAddressResolver = resolveHostAddresses,
): Promise<string | null> {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return null;
  if (h === '0.0.0.0') return null;
  if (PRIVATE_IP_RES.some((re) => re.test(h))) return null;
  try {
    const now = Date.now();
    let addresses: string[];
    const cached = dnsCache.get(h);
    if (resolver === resolveHostAddresses && cached && cached.expiresAt > now) {
      addresses = cached.addresses;
    } else {
      addresses = await resolveHostAddressesWithTimeout(h, resolver);
      if (resolver === resolveHostAddresses) {
        dnsCache.set(h, { addresses, expiresAt: now + DNS_CACHE_TTL_MS });
      }
    }
    for (const ip of addresses) {
      if (PRIVATE_IP_RES.some((re) => re.test(ip))) return null;
    }
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

export async function isPrivateHost(
  hostname: string,
  resolver: HostAddressResolver = resolveHostAddresses,
): Promise<boolean> {
  return (await resolveHostIp(hostname, resolver)) === null;
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

/**
 * Stream a `ReadableStream<Uint8Array>` body up to `maxBytes`, cancelling the
 * reader (and therefore the underlying HTTP connection) as soon as the cap is
 * reached. Returns the concatenated bytes, the total bytes actually buffered,
 * and whether the stream was cut short.
 *
 * Replaces the previous `await res.arrayBuffer()` approach, which always
 * buffered the full response in memory before post-hoc truncation and so
 * could blow up the agent process on a multi-MB page.
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean; totalBytes: number }> {
  if (!body) {
    return { buffer: Buffer.alloc(0), truncated: false, totalBytes: 0 };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total + value.length > maxBytes) {
        const need = maxBytes - total;
        if (need > 0) chunks.push(value.subarray(0, need));
        total = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* cancel is best-effort; the socket teardown below handles the rest */
        }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    if (!truncated && total === maxBytes) {
      const probe = await readProbeWithTimeout(reader, BODY_CAP_PROBE_TIMEOUT_MS);
      if (!probe || !probe.done) {
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* ignore cancel failure while unwinding a real error */
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* releaseLock may throw if the stream is already closed; safe to ignore */
    }
  }
  const buffer = Buffer.concat(
    chunks.map((c) => (c instanceof Uint8Array && !(c instanceof Buffer) ? Buffer.from(c) : (c as Buffer))),
    total,
  );
  return { buffer, truncated, totalBytes: total };
}

async function readProbeWithTimeout(
  reader: BodyProbeReader,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const resolveAddresses = opts.resolveHostAddresses ?? resolveHostAddresses;

  return {
    name: 'web_fetch',
    description:
      'Fetch an http(s) URL and return a readable text extract of the page. ' +
      'Useful when you need the content of a documentation / API reference / status page. ' +
      'Blocks private / loopback / link-local addresses by default (anti-SSRF). ' +
      'Truncates very large bodies. For live JS apps, prefer a headless browser tool.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
      permissionBoundary:
        'Performs outbound HTTP(S) only; private, loopback, and link-local targets are blocked by default.',
    },
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
      let verifiedIp: string | null = null;
      if (blockPrivate) {
        verifiedIp = await resolveHostIp(url.hostname, resolveAddresses);
        if (verifiedIp === null) {
          throw new DmossError({
            code: ErrorCode.TOOL_NOT_ALLOWED,
            message: `web_fetch: refused to connect to private host "${url.hostname}"`,
            hint:
              'Private/loopback/link-local IPs are blocked by default (SSRF protection). ' +
              'If you really need this (e.g. a trusted device), create the tool with `blockPrivateNetwork: false`.',
            recoverable: false,
          });
        }
      }

      const controller = new AbortController();
      const mergedSignal = ctx.abortSignal
        ? anySignal(ctx.abortSignal, controller.signal)
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      log.debug('start', { url: url.toString(), maxBytes, timeoutMs });
      const started = Date.now();
      const dispatchersToClose: ClosableDispatcher[] = [];
      try {
        let currentUrl = url;
        let res: Response;
        let redirectCount = 0;
        const MAX_REDIRECTS = 5;

        // Manual redirect following so we can re-check SSRF policy at each hop
        for (;;) {
          const fetchUrl = new URL(currentUrl.toString());
          const originalHost = currentUrl.host;
          // HTTP can be rewritten directly. HTTPS keeps the original hostname
          // for SNI/cert validation and pins DNS through a per-request dispatcher.
          const isHttps = currentUrl.protocol === 'https:';
          const shouldRewriteToIp = verifiedIp && !isHttps;
          if (shouldRewriteToIp) {
            fetchUrl.hostname = verifiedIp!;
          }
          const pinnedDispatcher =
            verifiedIp && isHttps ? await createPinnedHttpsDispatcher(verifiedIp) : undefined;
          if (pinnedDispatcher) dispatchersToClose.push(pinnedDispatcher);
          const fetchInit: RequestInit = {
            signal: mergedSignal,
            headers: {
              'User-Agent': userAgent,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
              ...(shouldRewriteToIp ? { Host: originalHost } : {}),
            },
            redirect: 'manual',
          };
          if (pinnedDispatcher) {
            (fetchInit as { dispatcher?: unknown }).dispatcher = pinnedDispatcher;
          }
          res = await fetch(fetchUrl.toString(), fetchInit);
          if (res.status >= 300 && res.status < 400 && redirectCount < MAX_REDIRECTS) {
            const location = res.headers.get('location');
            if (!location) break;
            let nextUrl: URL;
            try {
              nextUrl = new URL(location, currentUrl);
            } catch {
              break;
            }
            if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
              res.body?.cancel?.();
              throw new DmossError({
                code: ErrorCode.USER_INPUT_INVALID,
                message: `web_fetch: redirect to unsupported protocol ${nextUrl.protocol}`,
                hint: 'Only http: and https: redirects are allowed.',
                recoverable: false,
              });
            }
            redirectCount++;
            if (blockPrivate) {
              verifiedIp = await resolveHostIp(nextUrl.hostname, resolveAddresses);
              if (verifiedIp === null) {
                res.body?.cancel?.();
                throw new DmossError({
                  code: ErrorCode.TOOL_NOT_ALLOWED,
                  message: `web_fetch: redirect to private host "${nextUrl.hostname}" blocked (SSRF protection)`,
                  hint: 'The target server redirected to a private/internal address.',
                  recoverable: false,
                });
              }
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
         * Stream the body up to `maxBytes`, cancelling the response stream
         * (and therefore the underlying socket) once the cap is reached.
         * This avoids buffering multi-MB pages into the agent process.
         */
        const { buffer: body, truncated, totalBytes } = await readBodyCapped(
          res.body as ReadableStream<Uint8Array> | null,
          maxBytes,
        );
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
          out = `web_fetch_ok: ${totalBytes} bytes, binary content-type=${contentType || 'unknown'}; not returning binary data as text.`;
        }
        if (out.length > maxTextChars) {
          out = out.slice(0, maxTextChars) + `\n\n… (truncated at ${maxTextChars} chars)`;
        }
        const elapsed = Date.now() - started;
        log.debug('ok', {
          url: url.toString(),
          status: res.status,
          bytes: totalBytes,
          outChars: out.length,
          truncatedBytes: truncated,
          elapsedMs: elapsed,
        });
        const header = `web_fetch_ok: ${url.toString()} · HTTP ${res.status} · ${totalBytes}B${truncated ? ' (body truncated)' : ''} · ${elapsed}ms\n`;
        return header + '\n' + out;
      } catch (err) {
        // If it's already a DmossError (e.g., TOOL_NOT_ALLOWED for SSRF), rethrow directly
        // to preserve the security error classification and non-recoverable status.
        if (err instanceof DmossError) {
          throw err;
        }
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
        for (const dispatcher of dispatchersToClose) {
          await closeDispatcher(dispatcher);
        }
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
