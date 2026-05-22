/**
 * Knowledge Module Registry — manages domain knowledge modules for the D-Moss Agent.
 *
 * Modules are registered at startup and queried during prompt building,
 * tool execution analysis, and error recovery.
 */

import type {
  KnowledgeModule,
  DeviceProfileBase,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
} from '@dmoss/core/contracts/knowledge-module';
import type { DeviceFamily } from '@dmoss/core/contracts/device-family';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:knowledge');
const modules = new Map<string, KnowledgeModule>();

/**
 * Detect whether registering `mod` would introduce a direct 2-node
 * dependency cycle with an already-registered module (e.g. `A <-> B`).
 *
 * This is intentionally a shallow check: only direct reciprocal
 * dependencies are detected. Longer cycles (`A -> B -> C -> A`) are a
 * known, documented trade-off — see knowledge-module.ts JSDoc for
 * `KnowledgeModule.dependencies`.
 */
function warnIfDependencyCycle(mod: KnowledgeModule): void {
  const deps = mod.dependencies ?? [];
  if (deps.length === 0) return;
  for (const depId of deps) {
    const other = modules.get(depId);
    if (!other) continue;
    const otherDeps = other.dependencies ?? [];
    if (otherDeps.includes(mod.id)) {
      log.warn('dependency cycle detected', {
        modules: [mod.id, other.id],
        note: 'direct 2-node cycle; registration continues',
      });
    }
  }
}

export function registerKnowledgeModule(mod: KnowledgeModule): void {
  if (modules.has(mod.id)) {
    log.warn('replacing module', {
      id: mod.id,
      oldVersion: modules.get(mod.id)!.version,
      newVersion: mod.version,
    });
  }
  warnIfDependencyCycle(mod);
  modules.set(mod.id, mod);
  log.debug('registered', {
    id: mod.id,
    version: mod.version,
    platforms: mod.platforms.length,
  });
}

export function unregisterKnowledgeModule(id: string): boolean {
  return modules.delete(id);
}

export function getKnowledgeModule(id: string): KnowledgeModule | undefined {
  return modules.get(id);
}

export function getAllKnowledgeModules(): KnowledgeModule[] {
  return [...modules.values()];
}

export function findModuleForPlatform(platform: string): KnowledgeModule | undefined {
  const candidates: KnowledgeModule[] = [];
  for (const mod of modules.values()) {
    if (mod.platforms.includes(platform)) candidates.push(mod);
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    const pa = a.platformClaimPriority ?? 0;
    const pb = b.platformClaimPriority ?? 0;
    if (pb !== pa) return pb - pa;
    return a.id.localeCompare(b.id);
  });
  return candidates[0];
}

/**
 * Find the module that is authoritative for a given device family.
 *
 * Resolution order (mirrors `findModuleForPlatform`):
 *  1. Filter modules whose `family` matches the query.
 *  2. If multiple, sort by `platformClaimPriority DESC`, then by `id ASC`.
 *  3. Return the winner, or `undefined` when no candidate declares the
 *     family.
 *
 * Intended for the auto-detect flow: a fresh SSH probe returns a
 * `DeviceFamily` before the host resolves the concrete `platform`
 * identifier, and this function answers "which domain module owns
 * this family right now?".
 */
export function findModuleForFamily(family: DeviceFamily): KnowledgeModule | undefined {
  const candidates: KnowledgeModule[] = [];
  for (const mod of modules.values()) {
    if (mod.family === family) candidates.push(mod);
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    const pa = a.platformClaimPriority ?? 0;
    const pb = b.platformClaimPriority ?? 0;
    if (pb !== pa) return pb - pa;
    return a.id.localeCompare(b.id);
  });
  return candidates[0];
}

export function getAllDeviceProfiles(): Record<string, DeviceProfileBase> {
  const result: Record<string, DeviceProfileBase> = {};
  for (const mod of modules.values()) {
    Object.assign(result, mod.getDeviceProfiles());
  }
  return result;
}

export function getAllDocEntries(): DocIndexEntry[] {
  const entries: DocIndexEntry[] = [];
  for (const mod of modules.values()) {
    entries.push(...mod.getDocIndex());
  }
  return entries;
}

export function getAllPromptFragments(
  filter?: { tier?: string; mode?: string; section?: string },
): PromptFragment[] {
  const fragments: PromptFragment[] = [];
  const wantTier = filter?.tier && filter.tier !== 'all' ? filter.tier : undefined;
  const wantMode = filter?.mode && filter.mode !== 'all' ? filter.mode : undefined;
  for (const mod of modules.values()) {
    for (const f of mod.getPromptFragments()) {
      if (wantTier && f.tier !== 'all' && f.tier !== wantTier) continue;
      if (wantMode && f.mode !== 'all' && f.mode !== wantMode) continue;
      if (filter?.section && f.section !== filter.section) continue;
      fragments.push(f);
    }
  }
  return fragments.sort((a, b) => b.priority - a.priority);
}

export function getAllCommandPatterns(): CommandPattern[] {
  const patterns: CommandPattern[] = [];
  for (const mod of modules.values()) {
    patterns.push(...mod.getCommandPatterns());
  }
  return patterns;
}

export function getAllFailureHints(): FailureHint[] {
  const hints: FailureHint[] = [];
  for (const mod of modules.values()) {
    hints.push(...mod.getFailureHints());
  }
  return hints;
}

export function getAggregatedEcosystemPrompt(): string {
  const parts: string[] = [];
  for (const mod of modules.values()) {
    const p = mod.getEcosystemPrompt();
    if (p.trim()) parts.push(p);
  }
  return parts.join('\n\n');
}
