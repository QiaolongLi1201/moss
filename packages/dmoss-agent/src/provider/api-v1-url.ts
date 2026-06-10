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

export function buildApiV1Url(baseUrl: string, path: string): string {
  const normalizedBaseUrl = stripEndpointSuffix(baseUrl.trim());
  const normalizedPath = path.trim().replace(/^\/+/, '');
  return `${normalizedBaseUrl}/v1/${normalizedPath}`;
}
