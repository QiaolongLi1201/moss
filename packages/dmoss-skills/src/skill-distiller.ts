/**
 * Skill distiller — turns candidate evidence + teaching annotations into
 * a validated, scored SKILL.md draft ready for human or automated promotion.
 *
 * P0c: builds on `conversation-skill-learner.ts` markdown generation but
 * adds confidence scoring, teaching annotation injection, error recovery
 * patterns, and quality labels.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillCandidateEvidence } from "./skill-candidate-store.js";
import { getCandidatesRoot } from "./skill-candidate-store.js";
import { scoreSkillCandidate, isHighConfidence, type SkillScoreResult } from "./skill-scorer.js";

const DRAFT_FILE = "SKILL.draft.md";

export interface DistillResult {
  candidateId: string;
  draftPath: string;
  score: SkillScoreResult;
  markdown: string;
}

export async function distillCandidate(
  workspaceDir: string,
  candidateId: string,
  options?: { patternOccurrences?: number },
): Promise<DistillResult | null> {
  const candidatesRoot = getCandidatesRoot(workspaceDir);
  const candidateDir = path.join(candidatesRoot, candidateId);
  const candidatePath = path.join(candidateDir, "candidate.json");

  let evidence: SkillCandidateEvidence;
  try {
    evidence = JSON.parse(
      await fs.promises.readFile(candidatePath, "utf-8"),
    ) as SkillCandidateEvidence;
  } catch {
    return null;
  }

  const score = scoreSkillCandidate(evidence, options?.patternOccurrences);
  const markdown = buildDraftMarkdown(evidence, score);
  const draftPath = path.join(candidateDir, DRAFT_FILE);

  await fs.promises.writeFile(draftPath, markdown, "utf-8");

  return {
    candidateId: evidence.candidateId,
    draftPath,
    score,
    markdown,
  };
}

function yamlScalar(value: string, cap = 1000): string {
  const clean = value.replace(/\s+/g, " ").trim().slice(0, cap);
  return JSON.stringify(clean || "conversation skill");
}

function inferRisk(toolNames: string[]): "low" | "medium" | "high" {
  const joined = toolNames.join(" ");
  if (/flash|delete|rm|format|danger|deploy|install|upgrade/i.test(joined))
    return "medium";
  if (
    /device_|board_|exec|write|upload|open_url|community_|forum_|mail|im/i.test(
      joined,
    )
  )
    return "medium";
  return "low";
}

function inferPermissions(toolNames: string[]): string[] {
  const permissions = new Set<string>(["workspace_read"]);
  const joined = toolNames.join(" ");
  if (/device_|board_|fleet_|exec|ssh|openclaw/i.test(joined))
    permissions.add("device_exec");
  if (
    /write|upload|delete|rename|mkdir|local-skill|skill_mark_validated/i.test(
      joined,
    )
  )
    permissions.add("workspace_write");
  if (
    /web_|forum_|community_|skillhub|find_skills|network|fetch|search/i.test(
      joined,
    )
  )
    permissions.add("network");
  return [...permissions];
}

function titleFromText(text: string, fallback = "对话沉淀技能"): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean;
}

function formatToolStepForDistill(
  call: { name: string; input: Record<string, unknown> },
  index: number,
): string {
  const keys = Object.keys(call.input);
  const primaryKey = keys[0];
  const primaryVal = primaryKey
    ? String(call.input[primaryKey] ?? "").slice(0, 120)
    : "";
  const summary = primaryVal ? `: ${primaryKey}=${primaryVal}` : "";
  return `${index + 1}. \`${call.name}\`${summary}`;
}

function buildDraftMarkdown(
  evidence: SkillCandidateEvidence,
  score: SkillScoreResult,
): string {
  const { toolNames, toolCalls, userMessage, assistantText, teachingMeta, gate, sourceSessionKey, createdAt } = evidence;
  const risk = inferRisk(toolNames);
  const permissions = inferPermissions(toolNames);
  const requiresBoard = permissions.includes("device_exec");
  const name = `对话沉淀 ${titleFromText(userMessage)}`;

  const description = [
    "从一次已完成的宿主对话沉淀下来的可复用流程。",
    `适用于再次处理类似需求：${titleFromText(userMessage)}。`,
    "不适用：未验证完成、设备状态变化较大或用户要求重新探索的任务。",
  ].join(" ");

  // Quality label
  const qualityLabel = isHighConfidence(score) ? "high" : score.confidence >= 0.5 ? "medium" : "low";
  const qualityDescription = isHighConfidence(score)
    ? "多项信号支持此技能可复用（多工具、无错误、教学注解完整）"
    : score.confidence >= 0.5
      ? "中等置信度，建议人工确认后再 promote"
      : "低置信度，建议在相似场景验证成功后再 promote";

  // Teaching annotation sections
  const teachingSections = buildTeachingSections(teachingMeta);

  const steps = toolCalls
     .map((call, i) => formatToolStepForDistill(call, i))
    .join("\n");

  const rows = toolNames
    .map((tool) => `| \`${tool}\` | 本轮已验证工具链的一部分 | 是 |`)
    .join("\n");

  const errorRecoverySection =
    score.errorRecoveryPatterns.length > 0
      ? `\n## 错误恢复模式\n${score.errorRecoveryPatterns.map((p) => `- ${p}`).join("\n")}\n`
      : "";

  const preconditionSection =
    score.preconditions.length > 0
      ? `\n## 前置条件\n${score.preconditions.map((p) => `- ${p}`).join("\n")}\n`
      : "";

  const resultSummary = assistantText.replace(/\s+/g, " ").trim().slice(0, 700);

  const triggerList = [
    evidence.candidateId,
    ...toolNames,
    "对话沉淀",
    "conversation skill",
  ].join(",");

  return `---
schemaVersion: 1
name: ${yamlScalar(name, 120)}
description: ${yamlScalar(description, 1024)}
version: 1.0.0
trigger: ${yamlScalar(triggerList, 500)}
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
quality: ${qualityLabel}
confidence: ${score.confidence}
quality_description: ${yamlScalar(qualityDescription, 300)}
example_query: ${yamlScalar(userMessage, 120)}
---

# ${name}

> 质量评分：${qualityLabel.toUpperCase()} (${score.confidence})
> ${qualityDescription}

## 适用场景
- 用户再次提出与本轮相似的需求时，先阅读本技能复用已验证路径。
- 本技能来自真实对话中的成功工具链，不是示例或 mock 数据。
- 若设备、路径、版本或用户目标已经变化，先重新核实关键事实。

## 执行流程
${steps}
${toolCalls.length + 1}. 根据工具返回整理最终答复，并用只读检查或用户可见结果确认完成。
${errorRecoverySection}${preconditionSection}

## 工具映射
| 工具 | 用途 | 必需 |
|------|------|------|
${rows || "| 无 | 本轮未记录工具 | 否 |"}

${teachingSections}

## 沉淀来源
- 来源会话：\`${sourceSessionKey.replace(/`/g, "")}\`
- 沉淀门槛：${gate}
- 沉淀时间：${new Date(createdAt).toISOString()}
- 原始需求：${userMessage.replace(/\s+/g, " ").trim().slice(0, 300)}
- 本轮结果：${resultSummary || "已完成"}
- 完成类型：${evidence.runMeta.completionKind}
- 模型：${evidence.runMeta.model}

## 禁止事项
- 不要在没有用户授权时扩大写入、部署、删除或设备修改范围。
- 不要把本技能当作未验证场景的保证；关键环境变化时必须先重新确认。
`;
}

function buildTeachingSections(
  teachingMeta: SkillCandidateEvidence["teachingMeta"],
): string {
  if (
    !teachingMeta ||
    (!teachingMeta.preAnnotations?.length &&
      !teachingMeta.postAnnotations?.length)
  ) {
    return "";
  }

  let out = "## 教学注解\n\n";

  if (teachingMeta.preAnnotations?.length) {
    out += "### 执行要点\n";
    for (const pre of teachingMeta.preAnnotations) {
      if (pre.why) out += `- **为什么这么做**：${pre.why}\n`;
      if (pre.concept) out += `- **关键概念**：${pre.concept}\n`;
      if (pre.pitfalls?.length) {
        out += `- **常见坑**：${pre.pitfalls.join("；")}\n`;
      }
    }
    out += "\n";
  }

  if (teachingMeta.postAnnotations?.length) {
    out += "### 验证与恢复\n";
    for (const post of teachingMeta.postAnnotations) {
      if (post.verifyHint)
        out += `- **验证方法**：${post.verifyHint}\n`;
      if (post.nextStepIfFails)
        out += `- **失败对策**：${post.nextStepIfFails}\n`;
      if (post.rollbackHint)
        out += `- **回滚说明**：${post.rollbackHint}\n`;
      if (post.confidence)
        out += `- **本步置信度**：${post.confidence}\n`;
    }
    out += "\n";
  }

  return out;
}
