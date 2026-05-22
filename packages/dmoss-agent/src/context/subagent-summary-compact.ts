/** 写入父会话前的子代理摘要：控制长度并保留尾段结论 */
const DEFAULT_MAX = 1200;

export function compactSubagentSummaryForParent(raw: string, maxChars = DEFAULT_MAX): string {
  const text = String(raw ?? '').trim();
  if (text.length <= maxChars) return text;

  const headBudget = Math.floor(maxChars * 0.62);
  const tailBudget = maxChars - headBudget - 36;
  if (tailBudget < 80) {
    return `${text.slice(0, maxChars - 20)}\n…(已截断)`;
  }
  const omitted = text.length - headBudget - tailBudget;
  return (
    `${text.slice(0, headBudget)}\n\n[…子代理输出已压缩，省略 ${omitted} 字符…]\n\n${text.slice(-tailBudget)}`
  );
}
