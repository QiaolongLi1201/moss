/**
 * at-reference parser — extracts `@url`, `@bot`, `@docs`, and the at-reset directive from user messages.
 * (Avoids the literal `@reset` sequence in this line so TypeDoc does not treat it as a tag.)
 */

export interface AtRefBot { type: 'bot'; name: string }
export interface AtRefDocs { type: 'docs'; name: string }
export interface AtRefUrl { type: 'url'; url: string }
export interface AtRefReset { type: 'reset' }
export type AtRef = AtRefBot | AtRefDocs | AtRefUrl | AtRefReset;

export interface ParsedAtRefs {
  refs: AtRef[];
  cleanMessage: string;
  hasBot: boolean;
  hasReset: boolean;
  urls: string[];
  docNames: string[];
  botName?: string;
}

const RE_AT_BOT = /^@bot\s+(?:"([^"]+)"|'([^']+)'|(\S+))/im;
const RE_AT_DOCS = /@docs\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi;
const RE_AT_URL = /@url\s+(https?:\/\/\S+)/gi;
const RE_AT_RESET = /^@reset\b/im;

export function parseAtRefs(message: string): ParsedAtRefs {
  const refs: AtRef[] = [];
  const urls: string[] = [];
  const docNames: string[] = [];
  let botName: string | undefined;
  let hasBot = false;
  let hasReset = false;
  let cleaned = message;

  if (RE_AT_RESET.test(cleaned)) {
    refs.push({ type: 'reset' });
    hasReset = true;
    cleaned = cleaned.replace(RE_AT_RESET, '').trim();
  }

  const botMatch = RE_AT_BOT.exec(cleaned);
  if (botMatch) {
    const name = (botMatch[1] ?? botMatch[2] ?? botMatch[3]).trim();
    if (name) {
      refs.push({ type: 'bot', name });
      botName = name;
      hasBot = true;
      cleaned = cleaned.replace(botMatch[0], '').trim();
    }
  }

  let docsMatch: RegExpExecArray | null;
  const docsRe = new RegExp(RE_AT_DOCS.source, RE_AT_DOCS.flags);
  while ((docsMatch = docsRe.exec(cleaned)) !== null) {
    const name = (docsMatch[1] ?? docsMatch[2] ?? docsMatch[3]).trim();
    if (name) {
      refs.push({ type: 'docs', name });
      docNames.push(name);
    }
  }
  cleaned = cleaned.replace(new RegExp(RE_AT_DOCS.source, RE_AT_DOCS.flags), '').trim();

  let urlMatch: RegExpExecArray | null;
  const urlRe = new RegExp(RE_AT_URL.source, RE_AT_URL.flags);
  while ((urlMatch = urlRe.exec(cleaned)) !== null) {
    const url = urlMatch[1].trim();
    if (url) {
      refs.push({ type: 'url', url });
      urls.push(url);
    }
  }
  cleaned = cleaned.replace(new RegExp(RE_AT_URL.source, RE_AT_URL.flags), '').trim();

  return { refs, cleanMessage: cleaned, hasBot, hasReset, urls, docNames, botName };
}

export function hasAtRefs(message: string): boolean {
  return (
    RE_AT_RESET.test(message) ||
    RE_AT_BOT.test(message) ||
    new RegExp(RE_AT_DOCS.source, RE_AT_DOCS.flags).test(message) ||
    new RegExp(RE_AT_URL.source, RE_AT_URL.flags).test(message)
  );
}
