/**
 * Skill promoter — promotes a validated candidate from `skill-candidates/`
 * to a formal skill in `<workspace>/skills/`, then removes the candidate.
 *
 * P0d: the promote path is the only gate through which conversation-learned
 * skills enter the SkillRegistry and become routable. Unpromoted candidates
 * stay in `skill-candidates/` and are excluded from skill matching by
 * `run-setup.ts` filtering.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillCandidateEvidence } from "./skill-candidate-store.js";
import {
  getCandidatesRoot,
  removeCandidate,
} from "./skill-candidate-store.js";
import {
  mergeSkillFrontmatterDefaults,
  validateSkillContent,
  type SkillValidationResult,
} from "./skill-validation.js";
import { MOSS_SKILL_META_FILE } from "./skill-metadata.js";

async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, data, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
}

export interface PromoteResult {
  skillId: string;
  skillPath: string;
  candidateId: string;
  validation: SkillValidationResult;
  confidence?: number;
  promotedAt: number;
}

export interface PromoteOptions {
  workspaceDir: string;
  candidateId: string;
  /** Optional confidence score from the distiller. */
  confidence?: number;
  /** Called after successful promotion, before candidate removal. */
  onPromoted?: (result: PromoteResult) => void;
}

/**
 * Read a candidate and promote it into the formal skills directory.
 *
 * Steps:
 * 1. Read candidate.json from `<workspaceDir>/skill-candidates/<candidateId>/`
 * 2. Read SKILL.draft.md (or generate one from evidence)
 * 3. Validate the SKILL.md content
 * 4. Write to `<workspaceDir>/skills/<skillId>/SKILL.md`
 * 5. Write `.moss-skill.json` with `status: "promoted"` + quality metadata
 * 6. Remove the candidate
 */
export async function promoteSkillCandidate(
  opts: PromoteOptions,
): Promise<PromoteResult | null> {
  const { workspaceDir, candidateId, confidence } = opts;
  // Validate the candidate id up front (mirrors removeCandidate's guard): a
  // traversal id must never reach the candidate read path below, and the late
  // removeCandidate() call must not be the first thing to reject the id after
  // the skill has already been written to disk.
  if (!candidateId || /[/\\]/.test(candidateId) || candidateId.includes("..")) {
    throw new Error("Invalid candidate ID");
  }
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

  // Read draft or generate from evidence
  const draftPath = path.join(candidateDir, "SKILL.draft.md");
  let markdown: string;
  try {
    markdown = await fs.promises.readFile(draftPath, "utf-8");
  } catch {
    // Fallback: generate minimal markdown from evidence
    markdown = generateMinimalSkillMd(evidence);
  }

  // Use the existing `mergeSkillFrontmatterDefaults` so the skill has
  // the same default handling as skills written via `LocalMossSkillStore`.
  const normalized = mergeSkillFrontmatterDefaults(markdown, {
    skillId: candidateId,
  });

  const validation = validateSkillContent(normalized);
  if (!validation.valid) {
    throw new Error(
      `技能校验失败:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  const skillId = sanitizeSkillId(candidateId);
  const skillsDir = path.join(workspaceDir, "skills");
  const skillDir = path.join(skillsDir, skillId);

  await fs.promises.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  const metaPath = path.join(skillDir, MOSS_SKILL_META_FILE);
  const promotedAt = Date.now();

  try {
    await atomicWriteFile(skillPath, normalized);

    await atomicWriteFile(
      metaPath,
      JSON.stringify(
        {
          sourceKind: "conversation",
          status: "promoted",
          promotedAt,
          sourceCandidateId: candidateId,
          sourceSessionKey: evidence.sourceSessionKey,
          toolNames: evidence.toolNames,
          gate: evidence.gate,
          ...(confidence !== undefined ? { confidence } : {}),
          updatedAt: promotedAt,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    try {
      await fs.promises.rm(skillDir, { recursive: true, force: true });
    } catch {
      // rollback best-effort
    }
    throw err;
  }

  await removeCandidate(workspaceDir, candidateId);

  const result: PromoteResult = {
    skillId,
    skillPath,
    candidateId,
    validation,
    confidence,
    promotedAt,
  };

  opts.onPromoted?.(result);

  return result;
}

function sanitizeSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function generateMinimalSkillMd(
  evidence: SkillCandidateEvidence,
): string {
  const steps =
    evidence.toolCalls
      ?.map(
        (call, i) =>
          `${i + 1}. \`${call.name}\`${Object.keys(call.input).length > 0 ? ` — ${Object.keys(call.input).slice(0, 3).join(", ")}` : ""}`,
      )
      .join("\n") ?? "";

  return `---
name: 对话沉淀 ${evidence.userMessage.slice(0, 40)}
description: 从一次宿主对话沉淀的可复用流程
version: 1.0.0
trigger: ${[evidence.candidateId, ...evidence.toolNames, "对话沉淀"].join(",")}
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: confirm
cooldown_seconds: 0
category: Conversation
visible_in_empty: false
primary_intent: other
example_query: ${JSON.stringify(evidence.userMessage.slice(0, 120))}
---

# 对话沉淀技能

## 执行流程
${steps}

## 沉淀来源
- 来源会话：${evidence.sourceSessionKey}
- 沉淀门槛：${evidence.gate}
- 沉淀时间：${new Date(evidence.createdAt).toISOString()}
- 原始需求：${evidence.userMessage.slice(0, 300)}
`;
}
