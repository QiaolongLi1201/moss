/**
 * Prevents redundant web_fetch after a host "open URL" tool has already succeeded.
 * (Some reasoning models emit both open_url + web_fetch for the same link.)
 *
 * The guard is protocol-agnostic: it detects success via the configurable
 * `openUrlSuccessMarker` string (default: `open_url_ok`).  Host applications
 * that register a custom open-URL tool (e.g. `host_open_url`, `desktop_open_url`,
 * or any other brand-specific name) should call `setOpenUrlMarkers()` at startup
 * to match their tool's result format.
 */

import type { LLMMessage, LLMContentBlock } from '../llm/llm-provider.js';

// ---------------------------------------------------------------------------
// Configurable markers (host can override)
// ---------------------------------------------------------------------------

let openUrlSuccessMarker = 'open_url_ok';
let openUrlFailurePattern = /open_url\s*失败|open_url\s*fail/i;

export function setOpenUrlMarkers(opts: {
  successMarker?: string;
  failurePattern?: RegExp;
}): void {
  if (opts.successMarker) openUrlSuccessMarker = opts.successMarker;
  if (opts.failurePattern) openUrlFailurePattern = opts.failurePattern;
}

// ---------------------------------------------------------------------------
// Page-text intent detection
// ---------------------------------------------------------------------------

const PAGE_TEXT_INTENT_RE =
  /总结|摘要|正文|抓取|提取|爬取|摘录|全文|读了什么|网页内容|页面内容|主要内容|讲的什么|说了什么|copy\s*paste|复制.{0,4}内容/i;

export function latestUserGoalText(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      const t = m.content.trim();
      if (t) return m.content;
      continue;
    }
    const blocks = m.content as LLMContentBlock[];
    if (blocks.length > 0 && blocks.every((b) => b.type === 'tool_result')) continue;
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

export function userLikelyWantsPageTextExtracted(goal: string): boolean {
  return PAGE_TEXT_INTENT_RE.test(String(goal || '').trim());
}

function normalizeHttpUrl(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    u.hash = '';
    const path = (u.pathname.replace(/\/$/, '') || '/').toLowerCase();
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}

/** Parse URLs from an open-URL tool's success result text. */
export function parseUrlsFromOpenUrlToolResult(content: string): string[] {
  const c = String(content || '');
  if (!c.includes(openUrlSuccessMarker)) return [];
  if (openUrlFailurePattern.test(c)) return [];
  const re = new RegExp(`${openUrlSuccessMarker}:[^\\n]*(?:已请求打开|opened)\\s+([^\\s（()）【】「」『』《》。，；!！?？]+)`);
  const m = c.match(re);
  if (!m?.[1]) return [];
  return [m[1].trim()];
}

function collectOpenedUrlsFromHistory(messages: LLMMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content as LLMContentBlock[]) {
      if (b.type !== 'tool_result' || b.is_error) continue;
      out.push(...parseUrlsFromOpenUrlToolResult(b.content));
    }
  }
  return out;
}

/**
 * If the history shows the open-URL tool already succeeded for the same URL
 * and the user didn't explicitly ask for page text extraction, return a
 * suppression message to avoid a redundant web_fetch.
 */
export function maybeSuppressRedundantWebFetchAfterOpenUrl(
  messages: LLMMessage[],
  webFetchUrl: string,
): string | null {
  const goal = latestUserGoalText(messages);
  if (userLikelyWantsPageTextExtracted(goal)) return null;

  const target = normalizeHttpUrl(webFetchUrl);
  if (!target) return null;

  const opened = collectOpenedUrlsFromHistory(messages)
    .map(normalizeHttpUrl)
    .filter(Boolean) as string[];
  if (!opened.some((u) => u === target)) return null;

  return [
    `web_fetch_suppressed: the open-URL tool already opened this URL in the previous step.`,
    `If the user only asked to "open/view the site", reply briefly confirming the URL was opened; do not call web_fetch again for this URL (may cause empty SPA shell results and loops).`,
    `Only use web_fetch when the user explicitly asks for page text, summary, or excerpts.`,
  ].join('\n');
}
