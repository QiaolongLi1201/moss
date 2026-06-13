import {
  COMPACTION_SUMMARY_PREFIX,
  type Message,
} from "../core/session/session-jsonl.js";
import { sanitizeSecrets } from "../safety/secret-sanitizer.js";

const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DETERMINISTIC_SUMMARY_MAX_CHARS = 12_000;
const DETERMINISTIC_NOTE_MAX_CHARS = 900;

function truncateMiddle(text: string, maxChars: number): string {
  const clean = String(text ?? "").replace(/\s+\n/g, "\n").trim();
  if (clean.length <= maxChars) return clean;
  const head = Math.max(1, Math.floor(maxChars * 0.62));
  const tail = Math.max(1, maxChars - head - 32);
  return `${clean.slice(0, head).trimEnd()}\n...[省略 ${clean.length - head - tail} 字符]...\n${clean.slice(-tail).trimStart()}`;
}

function stringifyToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== "object") return "";
  const prioritized = ["path", "file_path", "cmd", "command", "url", "deviceId", "projectId"];
  const parts: string[] = [];
  for (const key of prioritized) {
    const value = input[key];
    if (value !== undefined) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  if (parts.length > 0) return parts.join(", ");
  try {
    return truncateMiddle(JSON.stringify(input), 300);
  } catch {
    return "[unserializable input]";
  }
}

function fallbackMessageNote(message: Message, index: number): string {
  const label = `${index + 1}. ${message.role}`;
  if (typeof message.content === "string") {
    return `${label}: ${sanitizeSecrets(truncateMiddle(message.content, DETERMINISTIC_NOTE_MAX_CHARS))}`;
  }

  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      parts.push(`text=${JSON.stringify(sanitizeSecrets(truncateMiddle(block.text, 420)))}`);
      continue;
    }
    if (block.type === "tool_use") {
      parts.push(`tool_use ${block.name ?? "tool"}(${sanitizeSecrets(stringifyToolInput(block.input))})`);
      continue;
    }
    if (block.type === "tool_result") {
      const body = sanitizeSecrets(truncateMiddle(block.content ?? "", 520));
      const status = block.aborted?.by
        ? ` aborted:${block.aborted.by}`
        : block.is_error ? " error" : "";
      parts.push(
        `tool_result ${block.name ?? "tool"}${status}: ${JSON.stringify(body)}`,
      );
    }
  }
  return `${label}: ${parts.join("; ")}`;
}

function textFromUserMessage(message: Message): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((block) => block.type === "text" && Boolean(block.text))
    .map((block) => block.type === "text" ? block.text : "")
    .join("\n");
}

function extractPrimaryUserGoal(messages: Message[]): string {
  for (const message of messages) {
    const text = textFromUserMessage(message).trim();
    if (!text) continue;
    if (text.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX)) continue;
    if (text.includes("<dmoss_working_context_checkpoint")) continue;
    if (text.includes("<dmoss_goal_checkpoint")) continue;
    return sanitizeSecrets(truncateMiddle(text, DETERMINISTIC_NOTE_MAX_CHARS));
  }
  return "未能从压缩窗口中可靠提取原始用户目标；继续前先核对当前任务。";
}

export function buildDeterministicCompactionSummary(
  messages: Message[],
  reason: string,
): string {
  if (messages.length === 0) return DEFAULT_SUMMARY_FALLBACK;
  const primaryGoal = extractPrimaryUserGoal(messages);
  const firstCount = 8;
  const lastCount = 18;
  const selected =
    messages.length <= firstCount + lastCount
      ? messages.map((message, index) => ({ message, index }))
      : [
          ...messages.slice(0, firstCount).map((message, index) => ({ message, index })),
          ...messages
            .slice(-lastCount)
            .map((message, offset) => ({
              message,
              index: messages.length - lastCount + offset,
            })),
        ];
  const omitted =
    messages.length > selected.length
      ? `\n\n（中间 ${messages.length - selected.length} 条消息未逐条展开；若继续任务需要更早原文，请优先重新读取相关文件/日志。）`
      : "";

  const notes: string[] = [];
  let used = 0;
  for (const item of selected) {
    const note = fallbackMessageNote(item.message, item.index);
    if (used + note.length > DETERMINISTIC_SUMMARY_MAX_CHARS) break;
    notes.push(note);
    used += note.length;
  }

  return [
    "## 0. 历史脉络",
    `本摘要由本地规则生成，用于防止上下文裁剪时失去主线。触发原因：${reason}。`,
    "## 1. 主要目标",
    primaryGoal,
    "## 2. 关键决策与约束",
    "保留摘录中的用户原话、路径、命令、错误和工具调用参数；不要把未确认事项当作已完成。",
    "## 3. 已完成的工作",
    "见第 9 节中 assistant/tool_result 摘录。",
    "## 4. 当前进行中",
    "当前上下文发生压缩；继续时应结合保留尾部消息和本摘要。",
    "## 5. 待办事项",
    "若保留尾部消息没有明确下一步，应先复述理解并请求用户确认。",
    "## 6. 设备与环境状态",
    "未由本地规则可靠判定；以保留尾部消息和后续工具查询为准。",
    "## 7. 关键文件与路径",
    "见第 9 节工具调用参数与消息摘录中的 path/file_path/cmd/url 字面量。",
    "## 8. 错误与问题",
    "见第 9 节 tool_result error 或错误文本摘录。",
    "## 9. 后续工作所需上下文",
    notes.join("\n"),
    omitted.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
