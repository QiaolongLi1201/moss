/**
 * Inline thinking tag router — splits LLM text deltas into "thinking" and "visible message" streams.
 *
 * Some OpenAI-compatible providers embed reasoning inside `<thinking>` / `<redacted_thinking>` tags
 * in the content delta. This module detects those tags in a streaming-safe manner and routes
 * the content into separate channels.
 */

const THINK_TAG_DEFS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<redacted_thinking>', close: '</redacted_thinking>' },
  { open: '<think>', close: '</think>' },
];

const THINK_BLOCK_RE = /<(thinking|redacted_thinking|think)>[\s\S]*?<\/\1>/gi;
const UNTERMINATED_THINK_BLOCK_RE = /<(?:thinking|redacted_thinking|think)>[\s\S]*$/i;
const STRAY_THINK_CLOSE_RE = /<\/(?:thinking|redacted_thinking|think)>/gi;

const OPEN_KEEP = Math.max(1, ...THINK_TAG_DEFS.map((d) => d.open.length - 1));

function closeKeepFor(close: string): number {
  return Math.max(1, close.length - 1);
}

function asciiLowerCode(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

function findInsensitive(haystack: string, needle: string): number {
  const nlen = needle.length;
  if (nlen === 0 || haystack.length < nlen) return -1;
  const lastStart = haystack.length - nlen;
  for (let i = 0; i <= lastStart; i++) {
    let j = 0;
    for (; j < nlen; j++) {
      if (asciiLowerCode(haystack.charCodeAt(i + j)) !== asciiLowerCode(needle.charCodeAt(j))) break;
    }
    if (j === nlen) return i;
  }
  return -1;
}

export type InlineThinkingRouter = {
  push: (delta: string) => { thinking: string[]; message: string[] };
  /** Reset after each text block ends to avoid cross-contamination */
  reset: () => void;
  /** Flush remaining carry when stream ends abnormally */
  end: () => { thinking: string[]; message: string[] };
};

export function createInlineThinkingRouter(): InlineThinkingRouter {
  let inThinking = false;
  let activeClose = '';
  let carry = '';

  const flush = (): { thinking: string[]; message: string[] } => {
    const thinking: string[] = [];
    const message: string[] = [];
    const emitThink = (s: string) => {
      if (s) thinking.push(s);
    };
    const emitMsg = (s: string) => {
      if (s) message.push(s);
    };

    while (carry.length > 0) {
      if (!inThinking) {
        let bestIdx = -1;
        let bestOpenLen = 0;
        let bestClose = '';
        for (const def of THINK_TAG_DEFS) {
          const o = findInsensitive(carry, def.open);
          if (o === -1) continue;
          if (bestIdx === -1 || o < bestIdx) {
            bestIdx = o;
            bestOpenLen = def.open.length;
            bestClose = def.close;
          }
        }
        if (bestIdx === -1) {
          if (carry.length > OPEN_KEEP) {
            emitMsg(carry.slice(0, carry.length - OPEN_KEEP));
            carry = carry.slice(carry.length - OPEN_KEEP);
          }
          break;
        }
        if (bestIdx > 0) emitMsg(carry.slice(0, bestIdx));
        carry = carry.slice(bestIdx + bestOpenLen);
        inThinking = true;
        activeClose = bestClose;
        continue;
      }
      const c = findInsensitive(carry, activeClose);
      if (c === -1) {
        const ck = closeKeepFor(activeClose);
        if (carry.length > ck) {
          emitThink(carry.slice(0, carry.length - ck));
          carry = carry.slice(carry.length - ck);
        }
        break;
      }
      if (c > 0) emitThink(carry.slice(0, c));
      carry = carry.slice(c + activeClose.length);
      inThinking = false;
      activeClose = '';
    }
    return { thinking, message };
  };

  return {
    push(delta: string) {
      carry += delta;
      return flush();
    },
    reset() {
      carry = '';
      inThinking = false;
      activeClose = '';
    },
    end() {
      const thinking: string[] = [];
      const message: string[] = [];
      if (!carry) return { thinking, message };
      if (inThinking) {
        if (carry) thinking.push(carry);
      } else if (carry) {
        message.push(carry);
      }
      carry = '';
      inThinking = false;
      activeClose = '';
      return { thinking, message };
    },
  };
}

/**
 * Extract all thinking tag bodies from a complete assistant text block.
 * Used for persisting thinking content and splitting visible text.
 */
export function splitThinkingTagsFromAssistantText(raw: string): { thinkingBodies: string[]; visible: string } {
  const thinkingBodies: string[] = [];
  let work = raw;
  let guard = 0;
  const maxPasses = 64;
  while (guard++ < maxPasses) {
    let bestIdx = -1;
    let bestDef: { open: string; close: string } | null = null;
    for (const def of THINK_TAG_DEFS) {
      const idx = findInsensitive(work, def.open);
      if (idx === -1) continue;
      if (bestIdx === -1 || idx < bestIdx) {
        bestIdx = idx;
        bestDef = def;
      }
    }
    if (bestIdx === -1 || !bestDef) break;
    const afterOpen = bestIdx + bestDef.open.length;
    const tail = work.slice(afterOpen);
    const closeRel = findInsensitive(tail, bestDef.close);
    if (closeRel === -1) break;
    const body = tail.slice(0, closeRel).trim();
    if (body) thinkingBodies.push(body);
    const end = afterOpen + closeRel + bestDef.close.length;
    work = (work.slice(0, bestIdx) + work.slice(end)).replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
  }
  return { thinkingBodies, visible: work.trim() };
}

/**
 * Remove inline thinking tags while preserving the remaining visible text.
 * Used when a host needs the final assistant body to match what the user saw.
 */
export function stripThinkingTagsKeepVisible(raw: string): string {
  const text = String(raw || '');
  if (!text) return '';
  return text
    .replace(THINK_BLOCK_RE, '')
    .replace(UNTERMINATED_THINK_BLOCK_RE, '')
    .replace(STRAY_THINK_CLOSE_RE, '');
}
