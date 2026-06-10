import { DmossError, ErrorCode } from '../errors.js';

/**
 * Wrap a provider fetch so network failures carry the target host and the
 * underlying cause. Node's `fetch` rejects with a bare "fetch failed"
 * TypeError and hides ENOTFOUND/ECONNREFUSED in `error.cause`, which made a
 * mistyped baseUrl indistinguishable from a dead network in the CLI output.
 */
export async function fetchWithConnectionContext(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Preserve user/agent aborts untouched: the loop branches on them.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (init.signal?.aborted) throw err;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep raw url */
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const causeText = cause?.code || cause?.message
      ? ` (${[cause?.code, cause?.message].filter(Boolean).join(': ')})`
      : '';
    const base = err instanceof Error ? err.message : String(err);
    throw new DmossError({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: `${base} for ${host}${causeText}`,
      hint: 'Check baseUrl, network/proxy reachability, and that the gateway is running.',
      recoverable: true,
      cause: err,
      context: { url: host },
    });
  }
}
