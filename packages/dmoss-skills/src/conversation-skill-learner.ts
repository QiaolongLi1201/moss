import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMMessage } from "./llm-message.js";

type LearnedToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  failed: boolean;
};

export type PersistedConversationSkill = {
  skillId: string;
  path: string;
  sourceKind: "conversation";
  toolNames: string[];
  /** 命中的门槛档：strict（自动严格门）/ intent（用户明确说要沉淀）/ legacy（旧的宽松门，仅在 env 显式开启时使用） */
  gate: "strict" | "intent" | "legacy";
};

/**
 * 显式意图检测结果。当用户用自然语言要求把当前流程沉淀为 skill 时，
 * 学习器会放宽硬性门槛（仍要求成功 + ≥2 工具调用）。
 */
export type SkillLearningIntent = {
  detected: boolean;
  /** 用户在指令里给出的自定义 slug（如 “沉淀为 yolo-bench 技能”里的 yolo-bench）。 */
  customSlug?: string;
};

export interface ConversationSkillLearnerInput {
  skillsDir: string;
  sessionKey: string;
  messages: LLMMessage[];
  /** 本轮（最近一轮）用户消息，用于 intent 判定与命名兜底。 */
  userMessage?: string;
  /** 本轮助手最终文本。 */
  assistantText?: string;
  /** 调用方做完的 intent 检测；缺省视为 `{ detected: false }`。 */
  intent?: SkillLearningIntent;
  /**
   * 旧字段：仅 legacy 门槛会用到（默认 2）。新逻辑下 strict 门槛固定 3+，intent
   * 门槛固定 2+。
   */
  minToolCalls?: number;
}

/** strict 门槛常量；这些值刻意大于 legacy，避免低价值对话落盘。 */
const STRICT_MIN_TOOL_CALLS = 3;
const STRICT_MIN_DISTINCT_TOOLS = 2;
const STRICT_MIN_ASSISTANT_CHARS = 120;
const STRICT_MIN_USER_CHARS = 12;
const STRICT_MAX_USER_CHARS = 600;
/** intent 门槛：用户明确要求时只需 2+ 工具调用，仍要求成功。 */
const INTENT_MIN_TOOL_CALLS = 2;
const GENERATED_META_FILE = ".rdkstudio-skill.json";

/**
 * env 开关：
 *   - `off`（默认）：彻底关闭自动沉淀（仍可由显式 intent 触发）。
 *   - `strict`：开启严格自动沉淀（高门槛，无 intent 也可写盘）。
 *   - `legacy`：恢复旧的宽松行为（仅用于 A/B 或回滚）。
 */
type AutoMode = "off" | "strict" | "legacy";

function readAutoMode(): AutoMode {
  const raw = String(process.env.RDK_DMOSS_AUTO_CONVERSATION_SKILL ?? "").trim().toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "legacy" || raw === "1") return "legacy";
  return "off";
}

function extractText(message: LLMMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
}

function isToolResultOnlyMessage(message: LLMMessage | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.length > 0 && message.content.every((block) => {
    return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result";
  });
}

/**
 * 从消息列表里找到一段「真正干活」的对话片段：
 *   1) 优先回溯最近若干轮，挑出 **工具调用数 ≥ minToolCalls 且 looksSuccessful** 的那一轮；
 *   2) 这避免了「用户在第 N 轮说『沉淀为 skill』、第 N 轮本身没有工具调用」时找不到可沉淀的素材。
 */
function pickSubstantiveTurn(
  messages: LLMMessage[],
  minToolCalls: number,
): { messages: LLMMessage[]; userText: string; assistantText: string; calls: LearnedToolCall[] } | null {
  const assistantIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") assistantIndexes.push(i);
    if (assistantIndexes.length >= 5) break;
  }
  for (const aIdx of assistantIndexes) {
    let userIdx = -1;
    for (let i = aIdx - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== "user" || isToolResultOnlyMessage(msg)) continue;
      userIdx = i;
      break;
    }
    if (userIdx < 0) continue;
    const slice = messages.slice(userIdx, aIdx + 1);
    const calls = extractToolCalls(slice);
    if (calls.length < minToolCalls) continue;
    const hasError = calls.some((c) => c.failed);
    const assistantText = extractText(messages[aIdx]);
    if (!looksSuccessful(hasError, assistantText)) continue;
    return {
      messages: slice,
      userText: extractText(messages[userIdx]),
      assistantText,
      calls,
    };
  }
  return null;
}

function extractToolCalls(messages: LLMMessage[]): LearnedToolCall[] {
  const calls: LearnedToolCall[] = [];
  const byId = new Map<string, LearnedToolCall>();

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block !== "object" || block === null) continue;
      const rec = block as Record<string, unknown>;
      if (rec.type === "tool_use") {
        const id = String(rec.id || "");
        const call: LearnedToolCall = {
          id,
          name: String(rec.name || "").trim(),
          input:
            rec.input && typeof rec.input === "object" && !Array.isArray(rec.input)
              ? rec.input as Record<string, unknown>
              : {},
          failed: false,
        };
        if (!call.name) continue;
        calls.push(call);
        if (id) byId.set(id, call);
      } else if (rec.type === "tool_result" && rec.is_error) {
        const id = String(rec.tool_use_id || "");
        const call = id ? byId.get(id) : calls[calls.length - 1];
        if (call) call.failed = true;
      }
    }
  }

  return calls;
}

function looksSuccessful(hasToolError: boolean, assistantText: string): boolean {
  const text = assistantText.trim();
  if (!text) return false;
  const success = /完成|成功|已修复|已验证|done|success|verified/i.test(text);
  const terminalFailure = /^(执行出错|未能完成)|\b(cancelled|failed)\b|已取消/i.test(text);
  if (terminalFailure && !success) return false;
  if (!hasToolError) return true;
  return success;
}

/**
 * 用户消息是否像「真任务」而不是「报错粘贴/XML 噪声/单词追问」。
 * 仅在 strict 门槛下要求；intent 门槛信任用户明确意图，不做这层判断。
 */
function userMessageLooksLikeTask(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (trimmed.length < STRICT_MIN_USER_CHARS) return false;
  if (trimmed.length > STRICT_MAX_USER_CHARS) return false;
  /** 像 XML / HTML 直接粘贴：跳过 */
  if (/^\s*<\?xml/i.test(trimmed)) return false;
  if (/^\s*<[a-zA-Z][^>]{0,80}>/.test(trimmed) && trimmed.includes("</")) return false;
  /** 像 stack trace / 报错：开头是 “Traceback / Error: / Exception” 且占多数 */
  if (/^\s*(Traceback|Error:|Exception|panic:)/i.test(trimmed)) return false;
  /** 字母+数字+常见 CJK 字符占比过低（说明是符号/乱码粘贴） */
  const meaningful = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (meaningful / trimmed.length < 0.5) return false;
  return true;
}

function inferRisk(toolNames: string[]): "low" | "medium" | "high" {
  const joined = toolNames.join(" ");
  if (/flash|delete|rm|format|danger|deploy|install|upgrade/i.test(joined)) return "medium";
  if (/device_|board_|exec|write|upload|studio_open|community_|forum_|mail|im/i.test(joined)) return "medium";
  return "low";
}

function inferPermissions(toolNames: string[]): string[] {
  const permissions = new Set<string>(["workspace_read"]);
  const joined = toolNames.join(" ");
  if (/device_|board_|fleet_|exec|ssh|openclaw/i.test(joined)) permissions.add("device_exec");
  if (/write|upload|delete|rename|mkdir|local-skill|skill_mark_validated/i.test(joined)) permissions.add("workspace_write");
  if (/web_|forum_|community_|skillhub|find_skills|network|fetch|search/i.test(joined)) permissions.add("network");
  return [...permissions];
}

function yamlScalar(value: string, cap = 1000): string {
  const clean = value.replace(/\s+/g, " ").trim().slice(0, cap);
  return JSON.stringify(clean || "conversation skill");
}

function titleFromUserMessage(userMessage: string, fallback = "对话沉淀技能"): string {
  const clean = userMessage.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean;
}

function sanitizeCustomSlug(value: string | undefined): string | null {
  if (!value) return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug.length < 3 || slug.length > 48) return null;
  return slug;
}

/**
 * 命名策略（用户最关心的「不能再出现 this-xml-file-does-not-afa28bfb 这种垃圾」）：
 *   1) 显式 intent 给了 `customSlug` → 用它（+短 hash 保唯一）；
 *   2) 用户消息能抽出 ≥2 个长度 ≥3 的 ASCII token 且看起来像任务 → 用 token + 短 hash；
 *   3) 否则用 `skill-YYYYMMDD-HHmm-<hash6>` 这种稳定格式，不再把整段粘贴塞进路径名。
 */
function skillIdFromTurn(input: {
  sessionKey: string;
  userMessage: string;
  toolNames: string[];
  intent?: SkillLearningIntent;
  createdAt: number;
}): string {
  const hash = crypto
    .createHash("sha1")
    .update([input.sessionKey, input.userMessage, input.toolNames.join(",")].join("\n"))
    .digest("hex")
    .slice(0, 6);

  const customSlug = sanitizeCustomSlug(input.intent?.customSlug);
  if (customSlug) {
    return `${customSlug}-${hash}`.slice(0, 64);
  }

  const tokens = (input.userMessage.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= 3 && !/^(0x[0-9a-f]+|x[0-9]+|p[0-9]+)$/.test(token))
    .slice(0, 4);
  const looksLikeTask = userMessageLooksLikeTask(input.userMessage);
  if (tokens.length >= 2 && looksLikeTask) {
    return `${tokens.join("-")}-${hash}`.replace(/-+/g, "-").slice(0, 64);
  }

  const stamp = new Date(input.createdAt);
  const yyyy = stamp.getUTCFullYear();
  const mm = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(stamp.getUTCDate()).padStart(2, "0");
  const hh = String(stamp.getUTCHours()).padStart(2, "0");
  const mi = String(stamp.getUTCMinutes()).padStart(2, "0");
  return `skill-${yyyy}${mm}${dd}-${hh}${mi}-${hash}`;
}

function redactInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 8).map(redactInput);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 180) return `${value.slice(0, 180)}...`;
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|token|secret|password|passwd|credential|authorization/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactInput(child);
    }
  }
  return out;
}

function formatToolStepForPrompt(call: LearnedToolCall): string {
  const input = JSON.stringify(redactInput(call.input));
  const compactInput = input.length > 220 ? `${input.slice(0, 220)}...` : input;
  return `\`${call.name}\`${compactInput && compactInput !== "{}" ? ` 输入：\`${compactInput.replace(/`/g, "'")}\`` : ""}`;
}

function uniqueToolNames(calls: LearnedToolCall[]): string[] {
  return [...new Set(calls.map((call) => call.name).filter(Boolean))];
}

/**
 * Trigger 仅放：
 *   - skillId 自己
 *   - 用户给的自定义 slug
 *   - 工具名（去重）
 *   - 固定标签 “对话沉淀” / “conversation skill”
 * **不再**把整段用户消息按标点切碎当 trigger，避免污染 `matchByText`。
 */
function buildTriggerList(input: {
  skillId: string;
  toolNames: string[];
  intent?: SkillLearningIntent;
}): string {
  const bits = new Set<string>([input.skillId, "对话沉淀", "conversation skill"]);
  const slug = sanitizeCustomSlug(input.intent?.customSlug);
  if (slug) bits.add(slug);
  for (const tool of input.toolNames) {
    if (tool) bits.add(tool);
  }
  return [...bits].join(",");
}

function buildSkillMarkdown(input: {
  skillId: string;
  userMessage: string;
  assistantText: string;
  sessionKey: string;
  calls: LearnedToolCall[];
  createdAt: number;
  intent?: SkillLearningIntent;
  gate: "strict" | "intent" | "legacy";
}): string {
  const toolNames = uniqueToolNames(input.calls);
  const risk = inferRisk(toolNames);
  const permissions = inferPermissions(toolNames);
  const requiresBoard = permissions.includes("device_exec");
  const customSlug = sanitizeCustomSlug(input.intent?.customSlug);
  const baseTitle = customSlug
    ? customSlug.replace(/-/g, " ")
    : titleFromUserMessage(input.userMessage);
  const name = `对话沉淀 ${baseTitle}`;
  const description = [
    "从一次已完成的 RDK Studio 对话沉淀下来的可复用流程。",
    `适用于再次处理类似需求：${titleFromUserMessage(input.userMessage)}。`,
    "不适用：未验证完成、设备状态变化较大或用户要求重新探索的任务。",
  ].join(" ");
  const trigger = buildTriggerList({
    skillId: input.skillId,
    toolNames,
    intent: input.intent,
  });
  const rows = toolNames
    .map((tool) => `| \`${tool}\` | 本轮已验证工具链的一部分 | 是 |`)
    .join("\n");
  const steps = input.calls
     .map((call, index) => `${index + 1}. ${formatToolStepForPrompt(call)}`)
    .join("\n");
  const resultSummary = input.assistantText.replace(/\s+/g, " ").trim().slice(0, 700);

  return `---
name: ${yamlScalar(name, 120)}
description: ${yamlScalar(description, 1024)}
version: 1.0.0
trigger: ${yamlScalar(trigger, 500)}
risk: ${risk}
permissions: ${permissions.join(",")}
delegate_preference: ${requiresBoard ? "board" : "local"}
requires_board: ${requiresBoard}
approval_level: ${risk === "low" ? "none" : "confirm"}
cooldown_seconds: 0
scheduler_template: none
category: Conversation
visible_in_empty: false
primary_intent: other
example_query: ${yamlScalar(input.userMessage, 120)}
---

# ${name}

## 适用场景
- 用户再次提出与本轮相似的需求时，先阅读本技能复用已验证路径。
- 本技能来自真实对话中的成功工具链，不是示例或 mock 数据。
- 若设备、路径、版本或用户目标已经变化，先重新核实关键事实。

## 执行流程
${steps}
${input.calls.length + 1}. 根据工具返回整理最终答复，并用只读检查或用户可见结果确认完成。

## 工具映射
| 工具 | 用途 | 必需 |
|------|------|------|
${rows || "| 无 | 本轮未记录工具 | 否 |"}

## 沉淀来源
- 来源会话：\`${input.sessionKey.replace(/`/g, "")}\`
- 沉淀门槛：${input.gate}
- 沉淀时间：${new Date(input.createdAt).toISOString()}
- 原始需求：${input.userMessage.replace(/\s+/g, " ").trim().slice(0, 300)}
- 本轮结果：${resultSummary || "已完成"}

## 禁止事项
- 不要在没有用户授权时扩大写入、部署、删除或设备修改范围。
- 不要把本技能当作未验证场景的保证；关键环境变化时必须先重新确认。
`;
}

/**
 * 在同一个 skillsDir 下寻找「同工具集 + 同槽位」的旧 conversation skill，
 * 用于覆盖去重。判定标准：同样的去重后工具名集合 + 同 customSlug（若有）。
 * 找不到返回 null；找到返回该旧目录路径，caller 可以直接重写其内的 SKILL.md。
 */
async function findDedupCandidate(
  skillsDir: string,
  toolNames: string[],
  customSlug?: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(skillsDir);
  } catch {
    return null;
  }
  const sortedTools = [...toolNames].sort().join("|");
  for (const entry of entries) {
    const metaPath = path.join(skillsDir, entry, GENERATED_META_FILE);
    let raw: string;
    try {
      raw = await fs.promises.readFile(metaPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: { sourceKind?: string; toolNames?: unknown; customSlug?: unknown } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.sourceKind !== "conversation") continue;
    const tools = Array.isArray(parsed.toolNames)
      ? parsed.toolNames.filter((x): x is string => typeof x === "string")
      : [];
    if ([...tools].sort().join("|") !== sortedTools) continue;
    if (customSlug && typeof parsed.customSlug === "string" && parsed.customSlug !== customSlug) {
      continue;
    }
    return path.join(skillsDir, entry);
  }
  return null;
}

async function writeGeneratedSkill(input: {
  skillsDir: string;
  skillId: string;
  markdown: string;
  sessionKey: string;
  toolNames: string[];
  createdAt: number;
  gate: "strict" | "intent" | "legacy";
  customSlug?: string;
  dedupTargetDir?: string | null;
}): Promise<PersistedConversationSkill> {
  await fs.promises.mkdir(input.skillsDir, { recursive: true });
  const skillDir = input.dedupTargetDir ?? path.join(input.skillsDir, input.skillId);
  await fs.promises.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.promises.writeFile(skillPath, input.markdown, "utf-8");
  await fs.promises.writeFile(
    path.join(skillDir, GENERATED_META_FILE),
    JSON.stringify({
      sourceKind: "conversation",
      updatedAt: input.createdAt,
      sourceSessionKey: input.sessionKey,
      toolNames: input.toolNames,
      gate: input.gate,
      ...(input.customSlug ? { customSlug: input.customSlug } : {}),
    }, null, 2),
    "utf-8",
  );
  return {
    skillId: path.basename(skillDir),
    path: skillPath,
    sourceKind: "conversation",
    toolNames: input.toolNames,
    gate: input.gate,
  };
}

/**
 * 在最近一段对话里检测「显式沉淀意图」。例如：
 *   - “把这个流程沉淀为技能”
 *   - “记住这套流程” / “记住这个方法”
 *   - “请生成 skill / save this as skill / persist as a workflow”
 * 同时尝试抓出用户给的自定义命名：`沉淀为 yolo-bench 技能` → slug=`yolo-bench`。
 *
 * 仅对最近一条用户消息做判定；caller 可在多轮里复用相同的 helper。
 */
export function detectSkillLearningIntent(userMessage: string): SkillLearningIntent {
  const msg = String(userMessage || "").replace(/\s+/g, " ").trim();
  if (!msg) return { detected: false };

  const zhPattern =
    /(把|帮我|帮忙|请)?[^。\n]{0,8}(沉淀|存为|存成|记为|另存|学会|学成|做成|生成|建为|建成|创建)[^。\n]{0,16}(技能|skill|工作流|流程|sop|方法)/i;
  const enPattern =
    /\b(save|persist|store|remember|record|turn|convert)\b[^.\n]{0,20}\b(as|into|to)\b[^.\n]{0,20}\b(skill|workflow|procedure|recipe|sop)\b/i;
  const inlinePattern = /(沉淀技能|记住这套流程|记住这个方法|save this as a skill|learn this as a skill)/i;

  const detected = zhPattern.test(msg) || enPattern.test(msg) || inlinePattern.test(msg);
  if (!detected) return { detected: false };

  /** 抓 “沉淀为 <slug> 技能” / “save as <slug> skill” 中的 <slug>。 */
  let customSlug: string | undefined;
  const zhSlug =
    msg.match(/(?:沉淀|存为|存成|记为|做成|生成|建为)[为成]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,40})\s*(?:技能|skill)/i)?.[1];
  const enSlug =
    msg.match(/\b(?:save|persist|store|remember|record)\b[^.\n]{0,12}\bas\b\s*([A-Za-z0-9_-]{2,40})\s*(?:skill|workflow)\b/i)?.[1];
  customSlug = zhSlug || enSlug || undefined;
  if (customSlug) {
    const cleaned = sanitizeCustomSlug(customSlug);
    if (cleaned) customSlug = cleaned; else customSlug = undefined;
  }

  return { detected: true, customSlug };
}

export async function maybePersistConversationSkill(
  input: ConversationSkillLearnerInput,
): Promise<PersistedConversationSkill | null> {
  const autoMode = readAutoMode();
  const intent = input.intent ?? { detected: false };

  /**
   * Gate 选择：
   *   - 用户明确说要沉淀 → intent 门（2 工具 + 成功）
   *   - 否则按 env：strict / legacy / off
   */
  const gate: "strict" | "intent" | "legacy" | null = intent.detected
    ? "intent"
    : autoMode === "strict"
      ? "strict"
      : autoMode === "legacy"
        ? "legacy"
        : null;

  if (gate === null) {
    /** 默认 off：不主动写盘。这是当前修复的核心默认行为。 */
    return null;
  }

  const minToolCalls =
    gate === "intent"
      ? INTENT_MIN_TOOL_CALLS
      : gate === "strict"
        ? STRICT_MIN_TOOL_CALLS
        : Math.max(input.minToolCalls ?? 2, 2);

  const turn = pickSubstantiveTurn(input.messages, minToolCalls);
  if (!turn) return null;

  const userMessage = String(input.userMessage || turn.userText || "").trim();
  const assistantText = String(input.assistantText || turn.assistantText || "").trim();
  if (!userMessage || !assistantText) return null;

  const calls = turn.calls;
  const toolNames = uniqueToolNames(calls);

  if (gate === "strict") {
    /** 严格自动模式的额外门槛：避免低价值/粘贴类对话落盘。 */
    if (toolNames.length < STRICT_MIN_DISTINCT_TOOLS) return null;
    if (assistantText.length < STRICT_MIN_ASSISTANT_CHARS) return null;
    if (calls.some((c) => c.failed)) return null;
    if (!userMessageLooksLikeTask(turn.userText || userMessage)) return null;
  }
  /** intent / legacy 门已在 pickSubstantiveTurn 内做 ≥ minToolCalls + looksSuccessful 过滤。 */

  const createdAt = Date.now();
  const customSlug = sanitizeCustomSlug(intent.customSlug);
  const skillId = skillIdFromTurn({
    sessionKey: input.sessionKey,
    userMessage: turn.userText || userMessage,
    toolNames,
    intent,
    createdAt,
  });

  const dedupTargetDir = await findDedupCandidate(
    input.skillsDir,
    toolNames,
    customSlug ?? undefined,
  );

  const markdown = buildSkillMarkdown({
    skillId,
    userMessage: turn.userText || userMessage,
    assistantText,
    sessionKey: input.sessionKey,
    calls,
    createdAt,
    intent,
    gate,
  });

  return writeGeneratedSkill({
    skillsDir: input.skillsDir,
    skillId,
    markdown,
    sessionKey: input.sessionKey,
    toolNames,
    createdAt,
    gate,
    customSlug: customSlug ?? undefined,
    dedupTargetDir,
  });
}
