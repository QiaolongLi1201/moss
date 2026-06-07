export function buildApiV1Url(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const normalizedPath = path.trim().replace(/^\/+/, '');
  return `${normalizedBaseUrl}/v1/${normalizedPath}`;
}
