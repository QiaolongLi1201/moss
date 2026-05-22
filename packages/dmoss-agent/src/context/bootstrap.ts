import fs from "node:fs/promises";
import path from "node:path";

import { isSubagentSessionKey } from "../core/session-key.js";

export type MemoryPolicy = {
  dailyMemoryDays?: number;
  mainReadsMemory?: boolean;
  sharedBlocksMemory?: boolean;
};

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

export type BootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type BootstrapFile = {
  name: BootstrapFileName | `memory/${string}.md`;
  path: string;
  content?: string;
  missing: boolean;
};

export type ContextFile = {
  path: string;
  content: string;
};

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME, DEFAULT_SOUL_FILENAME]);
const NON_MAIN_BLOCKLIST = new Set<BootstrapFileName>([
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
]);

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
const BOOTSTRAP_HEAD_RATIO = 0.7;
const BOOTSTRAP_TAIL_RATIO = 0.2;

type TrimBootstrapResult = {
  content: string;
  truncated: boolean;
  maxChars: number;
  originalLength: number;
  headChars: number;
  tailChars: number;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

export function resolveBootstrapMaxChars(maxChars?: number): number {
  const parsed = normalizePositiveInt(maxChars);
  return parsed ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
}

function trimBootstrapContent(
  content: string,
  fileName: string,
  maxChars: number,
): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
      headChars: trimmed.length,
      tailChars: 0,
    };
  }

  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = [
    "",
    `[...truncated, read ${fileName} for full content...]`,
    `…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
    "",
  ].join("\n");
  const contentWithMarker = [head, marker, tail].join("\n");
  return {
    content: contentWithMarker,
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
    headChars,
    tailChars,
  };
}

async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: BootstrapFileName | `memory/${string}.md`; filePath: string }>> {
  const candidates: BootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: BootstrapFileName; filePath: string }> = [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch {
      // optional
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  const seen = new Set<string>();
  const deduped: Array<{ name: BootstrapFileName; filePath: string }> = [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function formatDateToken(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function resolveDailyMemoryEntries(
  resolvedDir: string,
  policy?: MemoryPolicy,
): Promise<Array<{ name: `memory/${string}.md`; filePath: string }>> {
  const memoryDir = path.join(resolvedDir, "memory");
  const now = new Date();
  const envDays = process.env.DMOSS_DAILY_MEMORY_DAYS?.trim();
  const days = Math.max(1, policy?.dailyMemoryDays ?? (envDays ? Number(envDays) : 2));
  const candidates: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    candidates.push(formatDateToken(date));
  }
  const entries: Array<{ name: `memory/${string}.md`; filePath: string }> = [];
  for (const day of candidates) {
    const rel = `memory/${day}.md` as const;
    const full = path.join(memoryDir, `${day}.md`);
    try {
      await fs.access(full);
      entries.push({ name: rel, filePath: full });
    } catch {
      // optional
    }
  }
  return entries;
}

async function resolveBootstrapRoot(dir: string): Promise<string> {
  const resolvedDir = path.resolve(dir);
  const rootAgents = path.join(resolvedDir, DEFAULT_AGENTS_FILENAME);
  try {
    await fs.access(rootAgents);
    return resolvedDir;
  } catch {
    const agentDir = path.join(resolvedDir, "agent");
    const agentAgents = path.join(agentDir, DEFAULT_AGENTS_FILENAME);
    try {
      await fs.access(agentAgents);
      return agentDir;
    } catch {
      return resolvedDir;
    }
  }
}

export async function loadWorkspaceBootstrapFiles(
  dir: string,
  policy?: MemoryPolicy,
  fallbackDir?: string,
): Promise<BootstrapFile[]> {
  const resolvedDir = await resolveBootstrapRoot(dir);
  const fallbackResolvedDir = fallbackDir ? await resolveBootstrapRoot(fallbackDir) : null;
  const entries: Array<{
    name: BootstrapFileName | `memory/${string}.md`;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));
  entries.push(...(await resolveDailyMemoryEntries(resolvedDir, policy)));

  const result: BootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      const canFallback =
        fallbackResolvedDir &&
        entry.name === DEFAULT_SOUL_FILENAME;
      if (canFallback) {
        const fallbackPath = path.join(fallbackResolvedDir, entry.name);
        try {
          const fallbackContent = await fs.readFile(fallbackPath, "utf-8");
          result.push({
            name: entry.name,
            path: fallbackPath,
            content: fallbackContent,
            missing: false,
          });
          continue;
        } catch {
          // fallback unavailable
        }
      }

      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

let _nonMainChannelPrefixes = ["auto:", "channel:"];

/**
 * Register session key prefixes that identify non-main channel sessions.
 * Host applications should call this at startup to register product-specific
 * channel prefixes (e.g., messaging platform integrations).
 */
export function registerNonMainChannelPrefixes(prefixes: string[]): void {
  _nonMainChannelPrefixes = ["auto:", "channel:", ...prefixes];
}

export function filterBootstrapFilesForSession(
  files: BootstrapFile[],
  sessionKey?: string,
  policy?: MemoryPolicy,
): BootstrapFile[] {
  if (!sessionKey) return files;
  if (isSubagentSessionKey(sessionKey)) {
    return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name as BootstrapFileName));
  }
  const nonMain = _nonMainChannelPrefixes.some((p) => sessionKey.startsWith(p));
  const mainReadsMemory =
    policy?.mainReadsMemory ??
    (process.env.DMOSS_MAIN_READS_MEMORY !== undefined ? process.env.DMOSS_MAIN_READS_MEMORY !== '0' : true);
  const sharedBlocksMemory =
    policy?.sharedBlocksMemory ??
    (process.env.DMOSS_SHARED_BLOCKS_MEMORY !== undefined ? process.env.DMOSS_SHARED_BLOCKS_MEMORY !== '0' : true);
  if (!nonMain) {
    if (mainReadsMemory) return files;
    return files.filter((file) => !NON_MAIN_BLOCKLIST.has(file.name as BootstrapFileName));
  }
  if (!sharedBlocksMemory) return files;
  return files.filter((file) => !NON_MAIN_BLOCKLIST.has(file.name as BootstrapFileName));
}

export function buildBootstrapContextFiles(
  files: BootstrapFile[],
  opts?: { warn?: (message: string) => void; maxChars?: number },
): ContextFile[] {
  const maxChars = resolveBootstrapMaxChars(opts?.maxChars);
  const result: ContextFile[] = [];
  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }
    const trimmed = trimBootstrapContent(file.content ?? "", file.name, maxChars);
    if (!trimmed.content) {
      continue;
    }
    if (trimmed.truncated) {
      opts?.warn?.(
        `workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars ` +
          `(limit ${trimmed.maxChars}); truncating in injected context`,
      );
    }
    result.push({
      path: file.name,
      content: trimmed.content,
    });
  }
  return result;
}
