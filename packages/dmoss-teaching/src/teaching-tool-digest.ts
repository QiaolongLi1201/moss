/**
 * Stable digest for teach-while-solve pre-hook ↔ tool_start correlation (browser + Node).
 */

export function digestStudioToolCall(toolName: string, input: Record<string, unknown>): string {
  const stable = JSON.stringify({ toolName, input: stableSortKeys(input ?? {}) });
  return fnv1aFingerPrint(stable, 24);
}

function stableSortKeys(obj: Record<string, unknown>): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = stableSortKeys(v as Record<string, unknown>);
    } else {
      out[k] = v as unknown;
    }
  }
  return out;
}

function fnv1aFingerPrint(s: string, hexLen: number): string {
  let h = 0x811c9dc5 >>> 0;
  const rounds = [`0|${s.length}|`, '|', s];
  let out = '';
  for (let r = 0; r < rounds.length; r++) {
    const seg = rounds[r];
    let x = r * 374761393 + (h >>> 0);
    for (let i = 0; i < seg.length; i++) {
      x ^= seg.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    out += x.toString(16).padStart(8, '0');
    h = x;
  }
  return out.slice(0, hexLen);
}
