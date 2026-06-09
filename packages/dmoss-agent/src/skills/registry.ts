/**
 * Skill Registry — scans SKILL.md files from workspace and extra directories.
 *
 * Generic implementation; no hardware vendor knowledge.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillMeta, SkillPermission } from './types.js';
import { getRootLogger } from '../logger.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { listBuiltinSkills } from './builtin.js';

const log = getRootLogger().child('agent:skill-registry');

export interface SkillRegistryOptions {
  workspaceDir: string;
  extraDirs?: string[];
  includeBuiltin?: boolean;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const map: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
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

  loadAll(force = false): SkillMeta[] {
    const now = Date.now();
    if (!force && now - this.lastLoadedAt < 3000 && this.cache.length > 0) {
      return this.cache;
    }
    const paths = getMossWorkspacePaths(this.workspaceDir);
    const sources = [
      paths.skillsDir,
      paths.agentSkillsDir,
      paths.legacySkillsDir,
      paths.legacyAgentSkillsDir,
      ...this.extraDirs,
    ];
    const files = sources.flatMap((d) => collectSkillFiles(d));
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
