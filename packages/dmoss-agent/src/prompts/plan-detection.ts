/**
 * Chinese planning phrases → tool names, and web-intent tool name matching.
 * Shared by follow-up-guard, extract-tool-invocation, and agent-loop nudge logic.
 */

/**
 * 中文规划里「要调用 xxx」常见的 snake_case 工具名扫描。
 *
 * **保守策略**：只匹配明确的行动承诺（前缀词 + 调用 + 工具名）。
 * 与 `follow-up-guard.ts` 历史注释一致；.{0,20} 与 `extract-tool-invocation.ts` 对齐。
 */
export const CHINESE_PLAN_TOOL_INVOCATION_RE =
  /(?:我(?:来|要|去|将|先)|让我|然后|接下来|紧接(?:下来|着)|最后|下一步|下面|首先|随后).{0,20}?调用(?:这个|一下|该)?(?:工具)?\s*\b([a-z][a-z0-9_]{2,64})\b/gi;

/** 从规划中误抓的常见噪声 token（小写） */
export const NOISE_PLANNED_TOOL_NAMES = new Set(
  [
    'http',
    'https',
    'json',
    'url',
    'uri',
    'api',
    'the',
    'and',
    'for',
    'not',
    'you',
    'any',
    'all',
    'can',
    'tool',
    'call',
    'args',
    'null',
    'true',
    'false',
    'function',
    'object',
    'string',
    'number',
    'type',
    'this',
    'that',
    'with',
    'from',
    'into',
    'using',
  ].map((s) => s.toLowerCase()),
);

/**
 * English planning phrases → tool names, counterpart to CHINESE_PLAN_TOOL_INVOCATION_RE.
 * Matches patterns like "let me call web_fetch", "I'll use open_url", "I will now invoke ...".
 */
export const ENGLISH_PLAN_TOOL_INVOCATION_RE =
  /(?:let me|I(?:'ll| will| would)?(?: now| just| first)?)\s+(?:call|use|invoke|run|try|execute)\s+(?:the\s+)?`?([a-z][a-z0-9_]{2,64})`?/gi;

/** English negation before a plan match (avoid "don't call foo" false positives). */
export const ENGLISH_PLAN_NEGATION_BEFORE_RE =
  /(?:no|not|don't|won't|skip|avoid|without|no need|unnecessary)\s*$/i;

/** 匹配位置前若干字是否为否定/无法执行（避免「不要调用 foo」误触发） */
export const CHINESE_PLAN_NEGATION_BEFORE_RE =
  /(?:不|别|无需|不必|不用|无法|没有|未能|不要|勿)$/;

/**
 * 打开了网页/检索/文档意图的典型工具名；仅当出现在当前 {@link registeredToolNames} 中时才纳入正则，
 * 避免对未注册工具误 nudge。
 */
export const WEB_INTENT_TOOL_NAME_ALLOWLIST = [
  'web_fetch',
  'web_search',
  'open_url',
  'open_browser',
  'browser_capture',
  'doc_search',
  'doc_search_local',
] as const;

function looksLikeWebIntentToolName(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return (
    WEB_INTENT_TOOL_NAME_ALLOWLIST.includes(n as (typeof WEB_INTENT_TOOL_NAME_ALLOWLIST)[number]) ||
    /^web_/.test(n) ||
    /(?:^|_)open_url$/.test(n) ||
    /browser/.test(n) ||
    /^doc_search(?:_|$)/.test(n)
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构建「可见正文里出现了已注册的网页类工具名」检测用正则；无命中工具时返回永不匹配的正则。
 */
export function buildNamedWebToolMatcher(registeredToolNames: readonly string[]): RegExp {
  const allow = new Set(
    WEB_INTENT_TOOL_NAME_ALLOWLIST.map((x) => x.toLowerCase()),
  );
  const matched = registeredToolNames
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && (allow.has(n.toLowerCase()) || looksLikeWebIntentToolName(n)));
  if (matched.length === 0) return /(?!)/;
  const alt = [...new Set(matched.map((n) => escapeRegExp(n)))].sort().join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}
