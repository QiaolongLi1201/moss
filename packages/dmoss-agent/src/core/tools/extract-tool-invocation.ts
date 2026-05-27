/**
 * 从模型可见正文 + 思考链里「嗅探」出宿主工具调用，构造成 `{ type: 'tool_use' }` 块直接注入。
 *
 * 背景：
 * - 部分模型（doubao、qwen 等）在 `<thinking>` 里明确写出要调用的工具名和参数，但上游网关
 *   在它吐出 `tool_calls` 前就抛 `stream error`，客户端最终只看到一段描述性文字，工具没执行，
 *   用户反馈「说要调用却没调用」。
 * - 旧的「宿主意图注入」只能注入**无必填参数**的工具（`canHostInjectToolWithEmptyInput`），
 *   对 open-url / web-fetch 这类需要 URL 的工具无能为力。
 *
 * 设计原则：
 *   1. **保守**：只在 JSON Schema 约束下能拿到"看起来合理"的参数时才注入。参数缺失或歧义时返回 null，
 *      退回原有的 nudge/注入空参流程。
 *   2. **通用**：不写死任何宿主工具名；凡是 tool.inputSchema.properties 里声明的参数，按类型（string/url/number/boolean）
 *      用启发式从文本里尝试提取。URL 做格式校验，`number/boolean` 做类型转换；非基础类型与对象参数不尝试。
 *   3. **可扩展**：额外支持一个 per-tool 的「参数别名」映射（如 `url -> 链接/地址/url`）——从 schema 的
 *      `description` 里抽取，无需宿主单独配置。
 *
 * 此模块纯文本解析，零 I/O、无宿主依赖，便于在 @dmoss/agent vendor-neutral 约束下保留通用性。
 */

import type { Tool } from './tool-types.js';
import { CHINESE_PLAN_TOOL_INVOCATION_RE, ENGLISH_PLAN_TOOL_INVOCATION_RE } from '../../prompts/plan-detection.js';

/**
 * 从文本中找到**实际要使用**的 URL（排除说明性"例如/参考/见下文"等描述中出现的 URL）。
 * 简化实现：取第一个出现在「调用 toolName」或「url」等关键词附近的 URL；若无，就取第一个 http(s) URL。
 */
function extractUrlCandidate(text: string, toolName: string): string | null {
  const URL_RE = /https?:\/\/[^\s<>"'`，,。；;）)】\]]+/gi;
  const urls: { url: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    urls.push({ url: m[0]!, index: m.index });
  }
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0]!.url;

  /** 优先：最靠近"调用 <toolName>" 或 "url" 的 URL */
  const toolRe = new RegExp(`\\b${toolName}\\b`, 'i');
  const toolMatch = toolRe.exec(text);
  const urlKeywordRe = /(?:url|链接|地址|网址|uri)[=：:\s]*/gi;
  const keywordMatches: number[] = [];
  let km: RegExpExecArray | null;
  while ((km = urlKeywordRe.exec(text)) !== null) {
    keywordMatches.push(km.index);
  }
  const anchors: number[] = [];
  if (toolMatch) anchors.push(toolMatch.index);
  anchors.push(...keywordMatches);

  if (anchors.length > 0) {
    let best = urls[0]!;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const entry of urls) {
      for (const a of anchors) {
        const d = Math.abs(entry.index - a);
        if (d < bestDist) {
          bestDist = d;
          best = entry;
        }
      }
    }
    if (bestDist <= 80) return best.url;
  }
  return urls[0]!.url;
}

/**
 * 判断 schema 某个 property 是否"看起来是 URL"。
 * - type=string 且（description 含 "URL/URI/链接/网址/地址"，或参数名是 url/href/link/uri 等）
 */
function isUrlLikeProperty(name: string, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== 'string') return false;
  const lower = name.toLowerCase();
  if (lower === 'url' || lower === 'uri' || lower === 'href' || lower === 'link') return true;
  const desc = String(s.description ?? '').toLowerCase();
  if (/\b(url|uri|http|https)\b/.test(desc)) return true;
  if (/链接|网址|地址/.test(String(s.description ?? ''))) return true;
  return false;
}

function matchNumber(text: string, name: string): number | null {
  const re = new RegExp(`${name}\\s*[=：:]\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function matchBoolean(text: string, name: string): boolean | null {
  const re = new RegExp(`${name}\\s*[=：:]\\s*(true|false|是|否|开|关|on|off)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const v = m[1]!.toLowerCase();
  if (v === 'true' || v === '是' || v === '开' || v === 'on') return true;
  return false;
}

export interface ExtractedToolInvocation {
  name: string;
  input: Record<string, unknown>;
  /** 抽到了哪些 required 参数 */
  satisfiedRequired: string[];
  /** 仍缺失的 required 参数；非空则调用方应放弃注入 */
  missingRequired: string[];
}

/**
 * 从规划文本中找到第一个**完整可执行**的工具调用（工具名 + 所有 required 参数均可抽出）。
 * 返回 null 表示文本里没有明显的工具调用规划，或参数不全。
 *
 * @param text 拼接后的文本（建议：可见正文 + thinking 内容）
 * @param tools 当前可用工具集（用来按名查找 schema）
 */
export function extractToolInvocationFromPlanText(
  text: string,
  tools: readonly Tool[],
): ExtractedToolInvocation | null {
  const t = String(text || '');
  if (!t.trim()) return null;

  /**
   * 扫描文本里所有「调用 X_tool」的候选，按出现顺序返回。
   * Try Chinese plan regex first; if no match, fall back to English.
   * 正则与 `follow-up-guard` 共用 `CHINESE_PLAN_TOOL_INVOCATION_RE`（`plan-detection.ts`）。
   */
  const candidates: string[] = [];
  for (const baseRe of [CHINESE_PLAN_TOOL_INVOCATION_RE, ENGLISH_PLAN_TOOL_INVOCATION_RE]) {
    const planRe = new RegExp(baseRe.source, baseRe.flags);
    let m: RegExpExecArray | null;
    while ((m = planRe.exec(t)) !== null) {
      const raw = m[1]!.toLowerCase();
      if (!candidates.includes(raw)) candidates.push(raw);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;

  const toolByName = new Map(tools.map((tool) => [tool.name.toLowerCase(), tool]));

  for (const candidate of candidates) {
    const tool = toolByName.get(candidate);
    if (!tool) continue;
    const schema = tool.inputSchema;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const props = (schema?.properties ?? {}) as Record<string, unknown>;

    const input: Record<string, unknown> = {};
    const satisfied: string[] = [];
    const missing: string[] = [];

    for (const name of required) {
      const propSchema = props[name];
      if (!propSchema || typeof propSchema !== 'object') {
        missing.push(name);
        continue;
      }
      const type = (propSchema as Record<string, unknown>).type;

      if (isUrlLikeProperty(name, propSchema)) {
        const url = extractUrlCandidate(t, tool.name);
        if (url) {
          input[name] = url;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }
      if (type === 'number' || type === 'integer') {
        const n = matchNumber(t, name);
        if (n !== null) {
          input[name] = n;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }
      if (type === 'boolean') {
        const b = matchBoolean(t, name);
        if (b !== null) {
          input[name] = b;
          satisfied.push(name);
        } else {
          missing.push(name);
        }
        continue;
      }
      /**
       * 通用字符串：尝试匹配 `name=...` / `name："..."` 形式。
       * 过于激进会把无关短语也当成参数；因此仅在 description 提示它是 string 且 required 时启用。
       */
      if (type === 'string') {
        const stringPatterns = [
          new RegExp(`${name}\\s*[=：:]\\s*\"([^\"\\n]{1,2048})\"`, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*'([^'\\n]{1,2048})'`, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*\`([^\`\\n]{1,2048})\``, 'i'),
          new RegExp(`${name}\\s*[=：:]\\s*(\\S+[^\\n，,。；;]*)`, 'i'),
        ];
        let hit: string | null = null;
        for (const re of stringPatterns) {
          const sm = re.exec(t);
          if (sm && sm[1]) {
            hit = sm[1]!.trim();
            break;
          }
        }
        if (hit) {
          input[name] = hit;
          satisfied.push(name);
          continue;
        }
      }
      missing.push(name);
    }

    if (missing.length === 0) {
      return { name: tool.name, input, satisfiedRequired: satisfied, missingRequired: [] };
    }
  }
  return null;
}
