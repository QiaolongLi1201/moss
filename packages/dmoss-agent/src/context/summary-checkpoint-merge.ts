import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type Message,
} from "../core/session/session-jsonl.js";

const MERGED_PRIOR_SUMMARY_MAX_CHARS = 20_000;

export function isCompactionSummaryMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") {
    return message.content.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX);
  }
  return message.content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX),
  );
}

export function extractCompactionSummaryText(message: Message): string | null {
  const raw =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
  const start = raw.indexOf(COMPACTION_SUMMARY_PREFIX);
  if (start < 0) return null;
  const bodyStart = start + COMPACTION_SUMMARY_PREFIX.length;
  const end = raw.indexOf(COMPACTION_SUMMARY_SUFFIX, bodyStart);
  return (end >= 0 ? raw.slice(bodyStart, end) : raw.slice(bodyStart)).trim();
}

function truncateCheckpointText(text: string, maxChars: number): string {
  const clean = String(text ?? "").trim();
  if (clean.length <= maxChars) return clean;
  const head = Math.max(1, Math.floor(maxChars * 0.65));
  const tail = Math.max(1, maxChars - head - 48);
  return `${clean.slice(0, head).trimEnd()}\n...[省略 ${clean.length - head - tail} 字符]...\n${clean.slice(-tail).trimStart()}`;
}

export function mergePriorCompactionSummaries(summary: string, priorSummaries: string[]): string {
  const unique = priorSummaries
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, idx, arr) => arr.indexOf(s) === idx);
  if (unique.length === 0) return summary;

  const mergedPrior = truncateCheckpointText(
    unique.join("\n\n---\n\n"),
    MERGED_PRIOR_SUMMARY_MAX_CHARS,
  );
  return [
    "## 已合并的早期检查点",
    mergedPrior,
    "## 本次压缩新增摘要",
    summary.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
