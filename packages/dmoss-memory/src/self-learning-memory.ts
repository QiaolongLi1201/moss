import type { MemoryScope } from "./memory-manager.js";

export interface SelfLearningMemoryDraft {
  content: string;
  scope: MemoryScope;
}

function compactLine(text: string, max = 220): string {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

/**
 * Deterministic learning hook for explicit user feedback.
 *
 * The model is still encouraged to write richer memory after it understands the task,
 * but this catches the highest-value product feedback before a run starts.
 */
export function buildSelfLearningMemoryDraft(userMessage: string): SelfLearningMemoryDraft | null {
  const msg = compactLine(userMessage, 260);
  if (!msg) return null;
  const lower = msg.toLowerCase();

  const correction =
    /没改好|没有改好|不对|不太对|还是不行|不合理|很怪|奇怪|不好用|没法比|不够强|应该|以后|记住|记一下/.test(msg) ||
    /\b(not right|still broken|doesn't work|does not work|not good enough|remember|next time|should)\b/.test(lower);
  if (!correction) return null;

  const productOrUx =
    /体验|产品|用户|文字|文案|入口|页面|工作台|对话|聊天|记忆|迭代|审批|按钮|折叠|刷新|图片|附件|plan|ux|copy|memory|agent|approval|button|chat|workspace/.test(lower) ||
    /体验|产品|用户|文字|文案|入口|页面|工作台|对话|聊天|记忆|迭代|审批|按钮|折叠|刷新|图片|附件/.test(msg);

  const scope: MemoryScope = productOrUx ? "user" : "workspace";
  return {
    scope,
    content:
      `用户反馈/迭代信号: ${msg}\n` +
      "处理原则: 当用户指出没改好、不合理或提出稳定产品偏好时，不要只改表层；继续追查状态来源、入口路径和验证方式，并把可复用结论沉淀为 memory 或 skill。",
  };
}
