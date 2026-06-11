/**
 * Skill Registry — scans SKILL.md files from workspace and extra directories.
 *
 * Generic implementation; no hardware vendor knowledge.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillMeta, SkillPermission } from './types.js';
import { getRootLogger } from '../logger.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { listBuiltinSkills } from './builtin.js';

const log = getRootLogger().child('agent:skill-registry');

/**
 * Default skill roots scanned IN ADDITION to the workspace. Cross-agent
 * discovery: skills installed by skill-workshop / other agents live under the
 * user's home, not the moss workspace. These are vendor-neutral home roots, not
 * a single hard-coded vendor path — config (`skills.extraRoots`) can add to or
 * replace them. Only roots that exist are kept (a missing dir is silently
 * skipped, never an error).
 * @public
 */
export const DEFAULT_EXTRA_SKILL_ROOTS: readonly string[] = [
  '~/.claude/skills',
  '~/.agents/skills',
];

/**
 * Expand a leading `~` / `~/` to the user's home directory.
 * @public
 */
export function expandTilde(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Resolve the extra skill roots for a session: tilde-expand, make absolute,
 * keep only directories that exist, and dedupe by RESOLVED path so a root that
 * is also reachable from the workspace (or listed twice) is scanned once.
 * `configured` overrides the built-in defaults when provided (any array, incl.
 * empty, is honored — pass `undefined` to use the defaults).
 * @public
 */
export function resolveDefaultSkillRoots(
  configured?: readonly string[],
  home = os.homedir(),
): string[] {
  const raw = configured ?? DEFAULT_EXTRA_SKILL_ROOTS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = path.resolve(expandTilde(entry.trim(), home));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (fs.statSync(resolved).isDirectory()) out.push(resolved);
    } catch {
      // Missing root — skip silently (defaults legitimately may not exist).
    }
  }
  return out;
}

export interface SkillRegistryOptions {
  workspaceDir: string;
  extraDirs?: string[];
  includeBuiltin?: boolean;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const map: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    // Skip indented lines: they belong to a nested YAML block (e.g. a
    // `metadata:` map). Flattening them produced bogus top-level keys.
    if (/^\s/.test(line)) continue;
    // Skip list items and comments — not `key: value` pairs.
    if (/^\s*[-#]/.test(line)) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    // Strip a single layer of surrounding quotes from the value (Claude /
    // skill-workshop SKILL.md often quotes description). A bare `key:` with no
    // value is tolerated as an empty string.
    map[key] = line.slice(i + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return map;
}

function parseList(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function parsePermissions(raw?: string): SkillPermission {
  const perms = new Set(parseList(raw).map((s) => s.toLowerCase()));
  return {
    workspaceRead: perms.has('workspace_read'),
    workspaceWrite: perms.has('workspace_write'),
    deviceExec: perms.has('device_exec'),
    network: perms.has('network'),
  };
}

function getSkillAliases(meta: SkillMeta): string[] {
  const dirName = path.basename(path.dirname(meta.sourcePath));
  return [...new Set([
    meta.name, dirName, ...meta.tags, ...meta.trigger,
  ].map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function collectSkillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSkillFiles(full));
    } else if (entry.isFile() && entry.name.toUpperCase() === 'SKILL.MD') {
      out.push(full);
    }
  }
  return out;
}

export class SkillRegistry {
  private workspaceDir: string;
  private extraDirs: string[];
  private includeBuiltin: boolean;
  private cache: SkillMeta[] = [];
  private lastLoadedAt = 0;

  constructor(opts: SkillRegistryOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.extraDirs = opts.extraDirs ?? [];
    this.includeBuiltin = opts.includeBuiltin ?? true;
  }

  addExtraDir(dir: string): void {
    if (!this.extraDirs.includes(dir)) {
      this.extraDirs.push(dir);
      this.lastLoadedAt = 0;
    }
  }

  /** Snapshot of the configured extra roots (for display / reuse). @internal */
  extraDirsSnapshot(): string[] {
    return [...this.extraDirs];
  }

  loadAll(force = false): SkillMeta[] {
    const now = Date.now();
    if (!force && now - this.lastLoadedAt < 3000 && this.cache.length > 0) {
      return this.cache;
    }
    const paths = getMossWorkspacePaths(this.workspaceDir);
    // Source precedence: workspace-local roots first, then extra/home roots, so
    // a workspace SKILL.md wins a same-path collision with a cross-agent root.
    // Files are deduped by RESOLVED path so a root reachable two ways (listed
    // twice, or nested) is parsed once.
    const sources = [
      paths.skillsDir,
      paths.agentSkillsDir,
      paths.legacySkillsDir,
      paths.legacyAgentSkillsDir,
      ...this.extraDirs,
    ];
    const seenFiles = new Set<string>();
    const files: string[] = [];
    for (const dir of sources) {
      for (const file of collectSkillFiles(dir)) {
        const resolved = path.resolve(file);
        if (seenFiles.has(resolved)) continue;
        seenFiles.add(resolved);
        files.push(resolved);
      }
    }
    const metas: SkillMeta[] = this.includeBuiltin ? listBuiltinSkills() : [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const fm = parseFrontmatter(raw);
        metas.push({
          name: fm.name || path.basename(path.dirname(file)),
          description: fm.description || 'D-Moss skill',
          sourcePath: file,
          version: fm.version || '0.1.0',
          tags: parseList(fm.tags),
          trigger: parseList(fm.trigger || fm.triggers),
          risk: (fm.risk as 'low' | 'medium' | 'high') || 'medium',
          permissions: parsePermissions(fm.permissions),
          runtimePolicy: {
            delegatePreference: (fm.delegate_preference as 'local' | 'board' | 'hybrid' | 'collaborative') || 'hybrid',
            requiresBoard: fm.requires_board === 'true',
            approvalLevel: (fm.approval_level as 'none' | 'confirm' | 'strict') || 'confirm',
            cooldownSeconds: Number(fm.cooldown ?? fm.cooldown_seconds ?? '0') || undefined,
            schedulerTemplate: fm.scheduler_template || undefined,
          },
          enabled: fm.enabled !== 'false',
          updatedAt: fs.statSync(file).mtimeMs,
        });
      } catch (err) {
        log.warn('failed to parse', { file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.cache = metas.sort((a, b) => b.updatedAt - a.updatedAt);
    this.lastLoadedAt = now;
    return this.cache;
  }

  list(): SkillMeta[] { return this.loadAll(); }
  reload(): SkillMeta[] { return this.loadAll(true); }

  matchByText(text: string): SkillMeta[] {
    const q = text.toLowerCase().trim();
    if (!q) return [];
    const asciiWords = [
      ...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((t) => /^[a-z0-9]{2,}$/i.test(t))),
    ];
    return this.list().filter((s) => {
      if (!s.enabled) return false;
      const nameL = s.name.toLowerCase();
      const descL = s.description.toLowerCase();
      if (nameL.includes(q) || descL.includes(q)) return true;
      const nameSpaced = nameL.replace(/-/g, ' ');
      if (nameSpaced.includes(q) || q.includes(nameSpaced)) return true;
      if (asciiWords.length > 0) {
        const nameHay = nameSpaced;
        const descHay = descL.replace(/-/g, ' ');
        if (asciiWords.every((t) => nameHay.includes(t) || descHay.includes(t))) return true;
      }
      return s.trigger.some((t) => q.includes(t.toLowerCase()));
    });
  }

  rankByPreferredRefs(skills: SkillMeta[], preferredRefs: string[] = []): SkillMeta[] {
    if (preferredRefs.length === 0 || skills.length <= 1) return skills;
    const preferred = new Set(preferredRefs.map((item) => item.trim().toLowerCase()).filter(Boolean));
    return [...skills].sort((left, right) => {
      const lp = getSkillAliases(left).some((a) => preferred.has(a));
      const rp = getSkillAliases(right).some((a) => preferred.has(a));
      if (lp === rp) return 0;
      return lp ? -1 : 1;
    });
  }
}
