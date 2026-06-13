/**
 * Strips a pasted full endpoint ("/v1/chat/completions" etc.) down to the API
 * root. Users routinely copy the endpoint from provider docs; keeping it would
 * produce ".../chat/completions/v1/chat/completions" → opaque 404 at request
 * time.
 *
 * Single source of truth for endpoint-suffix normalization — used both when
 * SAVING a baseUrl (cli/setup) and when BUILDING request URLs (providers), so
 * the two paths can never drift apart.
 */
export function stripEndpointSuffix(value: string): string {
  return value
    .replace(/\/+$/, '')
    .replace(/\/(?:v1\/)?(?:chat\/completions|completions|embeddings)$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');
}

/**
 * True only for a syntactically valid absolute http(s) URL. Used at config
 * SET time so a malformed or non-http(s) baseUrl (typo'd scheme, bare host,
 * ftp://...) is rejected up front instead of failing opaquely at the first
 * model call.
 *
 * @public
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildApiV1Url(baseUrl: string, path: string): string {
  const normalizedBaseUrl = stripEndpointSuffix(baseUrl.trim());
  const normalizedPath = path.trim().replace(/^\/+/, '');
  return `${normalizedBaseUrl}/v1/${normalizedPath}`;
}
