import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SkillCandidateToolCall {
  name: string;
  input: Record<string, unknown>;
  failed: boolean;
}

export interface SkillCandidateTeachingMeta {
  preAnnotations?: Array<{
    argsDigest?: string;
    toolName?: string;
    why?: string;
    concept?: string;
    pitfalls?: string[];
  }>;
  postAnnotations?: Array<{
    toolCallId?: string;
    toolName?: string;
    verifyHint?: string;
    confidence?: string;
    confidenceReason?: string;
    nextStepIfFails?: string;
    rollbackSupported?: boolean;
    rollbackHint?: string;
    failureCard?: {
      cause?: string;
      actions?: string[];
      stopWhen?: string;
      rollbackAvailable?: boolean;
    };
  }>;
  annotatedToolNames?: string[];
  eligibleToolNames?: string[];
  annotationCoverage?: number;
}

export interface SkillCandidateEvidence {
  candidateId: string;
  sourceKind: "conversation";
  createdAt: number;
  sourceSessionKey: string;
  turnHash: string;
  gate: "strict" | "intent" | "legacy";
  toolCalls: SkillCandidateToolCall[];
  toolNames: string[];
  userMessage: string;
  assistantText: string;
  teachingMeta?: SkillCandidateTeachingMeta;
  runMeta: {
    completionKind: "complete" | "partial" | "cancelled" | "failed";
    model: string;
    totalElapsedMs: number;
    stopReason?: string;
  };
  customSlug?: string;
}

export interface CandidateStoreResult {
  candidateId: string;
  path: string;
  isNew: boolean;
  dedupedFrom?: string;
}

const CANDIDATES_DIR = "skill-candidates";
const CANDIDATE_FILE = "candidate.json";

async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, data, "utf-8");
  await fs.promises.rename(tmpPath, filePath);
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

function uniqueToolNames(calls: SkillCandidateToolCall[]): string[] {
  return [...new Set(calls.map((c) => c.name).filter(Boolean))];
}

function buildCandidateId(input: {
  sessionKey: string;
  userMessage: string;
  toolNames: string[];
  createdAt: number;
  customSlug?: string;
}): string {
  const hash = crypto
    .createHash("sha1")
    .update([input.sessionKey, input.userMessage, input.toolNames.join(",")].join("\n"))
    .digest("hex")
    .slice(0, 6);

  if (input.customSlug) {
    const slug = input.customSlug
      .toLowerCase()
      .replace(/[^a-z0-9一-龥-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (slug && slug.length >= 3 && slug.length <= 48) {
      return `${slug}-${hash}`.slice(0, 64);
    }
  }

  const tokens = (input.userMessage.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 3 && !/^(0x[0-9a-f]+|x[0-9]+|p[0-9]+)$/.test(t))
    .slice(0, 4);
  if (tokens.length >= 2) {
    return `${tokens.join("-")}-${hash}`.replace(/-+/g, "-").slice(0, 64);
  }

  const stamp = new Date(input.createdAt);
  const yyyy = stamp.getUTCFullYear();
  const mm = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(stamp.getUTCDate()).padStart(2, "0");
  const hh = String(stamp.getUTCHours()).padStart(2, "0");
  const mi = String(stamp.getUTCMinutes()).padStart(2, "0");
  return `candidate-${yyyy}${mm}${dd}-${hh}${mi}-${hash}`;
}

function candidatesRoot(workspaceDir: string): string {
  return path.join(workspaceDir, CANDIDATES_DIR);
}

async function findDedupTarget(
  workspaceDir: string,
  sessionKey: string,
  turnHash: string,
  sortedToolNames: string,
): Promise<string | null> {
  const root = candidatesRoot(workspaceDir);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidatePath = path.join(root, entry, CANDIDATE_FILE);
    let raw: string;
    try {
      raw = await fs.promises.readFile(candidatePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: { sourceKind?: string; sourceSessionKey?: string; turnHash?: string; toolNames?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.sourceKind !== "conversation") continue;
    if (parsed.sourceSessionKey !== sessionKey) continue;
    if (parsed.turnHash !== turnHash) continue;
    const tools = Array.isArray(parsed.toolNames)
      ? parsed.toolNames.filter((x): x is string => typeof x === "string")
      : [];
    if ([...tools].sort().join("|") !== sortedToolNames) continue;
    return path.join(root, entry);
  }
  return null;
}

export async function writeSkillCandidate(input: {
  workspaceDir: string;
  sessionKey: string;
  turnHash: string;
  gate: "strict" | "intent" | "legacy";
  toolCalls: SkillCandidateToolCall[];
  userMessage: string;
  assistantText: string;
  teachingMeta?: SkillCandidateTeachingMeta;
  runMeta: SkillCandidateEvidence["runMeta"];
  customSlug?: string;
}): Promise<CandidateStoreResult | null> {
  const toolNames = uniqueToolNames(input.toolCalls);
  if (toolNames.length === 0) return null;

  const createdAt = Date.now();
  const candidateId = buildCandidateId({
    sessionKey: input.sessionKey,
    userMessage: input.userMessage,
    toolNames,
    createdAt,
    customSlug: input.customSlug,
  });

  const root = candidatesRoot(input.workspaceDir);
  await fs.promises.mkdir(root, { recursive: true });

  const sortedKeys = [...toolNames].sort().join("|");
  const dedupTargetDir = await findDedupTarget(
    input.workspaceDir,
    input.sessionKey,
    input.turnHash,
    sortedKeys,
  );

  const targetDir = dedupTargetDir ?? path.join(root, candidateId);
  await fs.promises.mkdir(targetDir, { recursive: true });

  const evidence: SkillCandidateEvidence = {
    candidateId,
    sourceKind: "conversation",
    createdAt,
    sourceSessionKey: input.sessionKey,
    turnHash: input.turnHash,
    gate: input.gate,
    toolCalls: input.toolCalls.map((c) => ({
      name: c.name,
      input: redactInput(c.input) as Record<string, unknown>,
      failed: c.failed,
    })),
    toolNames,
    userMessage: input.userMessage.replace(/\s+/g, " ").trim().slice(0, 600),
    assistantText: input.assistantText.replace(/\s+/g, " ").trim().slice(0, 700),
    teachingMeta: input.teachingMeta,
    runMeta: input.runMeta,
    customSlug: input.customSlug,
  };

  const candidatePath = path.join(targetDir, CANDIDATE_FILE);
  await atomicWriteFile(
    candidatePath,
    JSON.stringify(evidence, null, 2),
  );

  return {
    candidateId: path.basename(targetDir),
    path: candidatePath,
    isNew: !dedupTargetDir,
    dedupedFrom: dedupTargetDir ? path.basename(dedupTargetDir) : undefined,
  };
}

export async function listCandidates(
  workspaceDir: string,
  filters?: { gate?: string; toolName?: string; minCreatedAt?: number },
): Promise<SkillCandidateEvidence[]> {
  const root = candidatesRoot(workspaceDir);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return [];
  }

  const results: SkillCandidateEvidence[] = [];
  for (const entry of entries) {
    const candidatePath = path.join(root, entry, CANDIDATE_FILE);
    let raw: string;
    try {
      raw = await fs.promises.readFile(candidatePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: SkillCandidateEvidence;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (filters?.gate && parsed.gate !== filters.gate) continue;
    if (filters?.toolName && !parsed.toolNames.includes(filters.toolName)) continue;
    if (filters?.minCreatedAt && parsed.createdAt < filters.minCreatedAt) continue;
    results.push(parsed);
  }
  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export async function removeCandidate(
  workspaceDir: string,
  candidateId: string,
): Promise<boolean> {
  // H2: Validate candidateId to prevent path traversal
  if (!candidateId || /[/\\]/.test(candidateId) || candidateId.includes('..')) {
    throw new Error('Invalid candidate ID');
  }
  const targetDir = path.join(candidatesRoot(workspaceDir), candidateId);
  try {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getCandidatesRoot(workspaceDir: string): string {
  return candidatesRoot(workspaceDir);
}