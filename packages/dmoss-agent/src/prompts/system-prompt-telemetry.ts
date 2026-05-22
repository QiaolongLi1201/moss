/**
 * System prompt telemetry — hash system prompt layers for observability and cache analysis.
 */
import crypto from 'node:crypto';

export function hashSystemPromptForTelemetry(combined: string, layerIds: string[]): {
  combinedHashShort: string;
  combinedLength: number;
  layerHashes: Record<string, string>;
} {
  const combinedHashShort = crypto.createHash('sha256').update(combined, 'utf8').digest('hex').slice(0, 16);
  const layerHashes: Record<string, string> = {};
  for (const id of layerIds) {
    const start = combined.indexOf(`[[LAYER:${id}]]`);
    if (start === -1) continue;
    const end = combined.indexOf(`[[/LAYER:${id}]]`, start);
    if (end === -1) continue;
    const slice = combined.slice(start + `[[LAYER:${id}]]`.length, end);
    layerHashes[id] = crypto.createHash('sha256').update(slice, 'utf8').digest('hex').slice(0, 12);
  }
  return { combinedHashShort, combinedLength: combined.length, layerHashes };
}

export function hashSystemPromptLayers(
  combined: string,
  layers: ReadonlyArray<{ id: string; content: string }>,
): {
  combinedHashShort: string;
  combinedLength: number;
  layerHashes: Record<string, string>;
} {
  const combinedHashShort = crypto.createHash('sha256').update(combined, 'utf8').digest('hex').slice(0, 16);
  const layerHashes: Record<string, string> = {};
  for (const l of layers) {
    if (!l.content.trim()) continue;
    layerHashes[l.id] = crypto.createHash('sha256').update(l.content, 'utf8').digest('hex').slice(0, 12);
  }
  return { combinedHashShort, combinedLength: combined.length, layerHashes };
}

export function hashStableDynamicSystemPrompt(stablePrefix: string, dynamicSuffix: string): {
  stableHashShort: string;
  dynamicHashShort: string;
} {
  const stableHashShort = crypto.createHash('sha256').update(stablePrefix, 'utf8').digest('hex').slice(0, 12);
  const dynamicHashShort = crypto.createHash('sha256').update(dynamicSuffix, 'utf8').digest('hex').slice(0, 12);
  return { stableHashShort, dynamicHashShort };
}
