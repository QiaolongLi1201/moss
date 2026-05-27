/**
 * Knowledge Module Registry — manages domain knowledge modules for the D-Moss Agent.
 *
 * Modules are registered at startup and queried during prompt building,
 * tool execution analysis, and error recovery.
 *
 * The `KnowledgeRegistry` class is instance-scoped: each `DmossAgent` owns its
 * own registry so multi-agent scenarios are isolated. Module-level functions
 * are retained as backward-compatible wrappers around a default process-scoped
 * instance (deprecated — prefer the class).
 */

import type {
  KnowledgeModule,
  DeviceProfileBase,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
} from '@dmoss/core';
import type { DeviceFamily } from '@dmoss/core';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:knowledge');

// ─── KnowledgeRegistry class ────────────────────────────────────

export class KnowledgeRegistry {
  private readonly modules = new Map<string, KnowledgeModule>();

  /**
   * Detect whether registering `mod` would introduce a direct 2-node
   * dependency cycle with an already-registered module (e.g. `A <-> B`).
   *
   * This is intentionally a shallow check: only direct reciprocal
   * dependencies are detected. Longer cycles (`A -> B -> C -> A`) are a
   * known, documented trade-off — see knowledge-module.ts JSDoc for
   * `KnowledgeModule.dependencies`.
   */
  private warnIfDependencyCycle(mod: KnowledgeModule): void {
    const deps = mod.dependencies ?? [];
    if (deps.length === 0) return;
    for (const depId of deps) {
      const other = this.modules.get(depId);
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

  register(mod: KnowledgeModule): void {
    if (this.modules.has(mod.id)) {
      log.warn('replacing module', {
        id: mod.id,
        oldVersion: this.modules.get(mod.id)!.version,
        newVersion: mod.version,
      });
    }
    this.warnIfDependencyCycle(mod);
    this.modules.set(mod.id, mod);
    log.debug('registered', {
      id: mod.id,
      version: mod.version,
      platforms: mod.platforms.length,
    });
  }

  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  get(id: string): KnowledgeModule | undefined {
    return this.modules.get(id);
  }

  getAll(): KnowledgeModule[] {
    return [...this.modules.values()];
  }

  findForPlatform(platform: string): KnowledgeModule | undefined {
    const candidates: KnowledgeModule[] = [];
    for (const mod of this.modules.values()) {
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
   * Resolution order (mirrors `findForPlatform`):
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
  findForFamily(family: DeviceFamily): KnowledgeModule | undefined {
    const candidates: KnowledgeModule[] = [];
    for (const mod of this.modules.values()) {
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

  getAllDeviceProfiles(): Record<string, DeviceProfileBase> {
    const result: Record<string, DeviceProfileBase> = {};
    for (const mod of this.modules.values()) {
      Object.assign(result, mod.getDeviceProfiles());
    }
    return result;
  }

  getAllDocEntries(): DocIndexEntry[] {
    const entries: DocIndexEntry[] = [];
    for (const mod of this.modules.values()) {
      entries.push(...mod.getDocIndex());
    }
    return entries;
  }

  getAllPromptFragments(
    filter?: { tier?: string; mode?: string; section?: string },
  ): PromptFragment[] {
    const fragments: PromptFragment[] = [];
    const wantTier = filter?.tier && filter.tier !== 'all' ? filter.tier : undefined;
    const wantMode = filter?.mode && filter.mode !== 'all' ? filter.mode : undefined;
    for (const mod of this.modules.values()) {
      for (const f of mod.getPromptFragments()) {
        if (wantTier && f.tier !== 'all' && f.tier !== wantTier) continue;
        if (wantMode && f.mode !== 'all' && f.mode !== wantMode) continue;
        if (filter?.section && f.section !== filter.section) continue;
        fragments.push(f);
      }
    }
    return fragments.sort((a, b) => {
      // M6: stable sort — priority desc, then section asc as tiebreaker for cache stability.
      const prioDiff = b.priority - a.priority;
      if (prioDiff !== 0) return prioDiff;
      return (a.section ?? '').localeCompare(b.section ?? '');
    });
  }

  getAllCommandPatterns(): CommandPattern[] {
    const patterns: CommandPattern[] = [];
    for (const mod of this.modules.values()) {
      patterns.push(...mod.getCommandPatterns());
    }
    return patterns;
  }

  getAllFailureHints(): FailureHint[] {
    const hints: FailureHint[] = [];
    for (const mod of this.modules.values()) {
      hints.push(...mod.getFailureHints());
    }
    return hints;
  }

  getAggregatedEcosystemPrompt(): string {
    // M6: sort modules by id for stable prompt ordering (cache hit rate).
    const sortedModules = [...this.modules.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, mod]) => mod);
    const parts: string[] = [];
    for (const mod of sortedModules) {
      const p = mod.getEcosystemPrompt();
      if (p.trim()) parts.push(p);
    }
    return parts.join('\n\n');
  }

  /** Clear all registered modules. */
  dispose(): void {
    this.modules.clear();
  }
}

// ─── Default process-scoped instance (backward compatibility) ───

const defaultRegistry = new KnowledgeRegistry();

// H2: Track modules registered via deprecated global function so new DmossAgent
// instances can pick them up. Prevents the silent footgun where global
// registration goes to a different registry than the agent's instance.
const pendingGlobalModules: KnowledgeModule[] = [];
let deprecationWarningEmitted = false;

/**
 * H2: Drain pending global modules into a target registry.
 * Called by DmossAgent constructor to bridge deprecated global registrations.
 * Modules are drained (not copied) so multiple agents each get their own copy.
 */
export function drainPendingGlobalModules(target: KnowledgeRegistry): void {
  for (const mod of pendingGlobalModules) {
    target.register(mod);
  }
}

/**
 * @deprecated Use `agent.registerKnowledge(mod)` on a DmossAgent instance instead.
 * Modules registered here are bridged into new DmossAgent instances at construction time.
 */
export function registerKnowledgeModule(mod: KnowledgeModule): void {
  if (!deprecationWarningEmitted) {
    log.warn(
      'registerKnowledgeModule() is deprecated — use agent.registerKnowledge(mod) instead. ' +
      'Global registrations are bridged into new DmossAgent instances at construction time.',
    );
    deprecationWarningEmitted = true;
  }
  defaultRegistry.register(mod);
  pendingGlobalModules.push(mod);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function unregisterKnowledgeModule(id: string): boolean {
  return defaultRegistry.unregister(id);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getKnowledgeModule(id: string): KnowledgeModule | undefined {
  return defaultRegistry.get(id);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllKnowledgeModules(): KnowledgeModule[] {
  return defaultRegistry.getAll();
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function findModuleForPlatform(platform: string): KnowledgeModule | undefined {
  return defaultRegistry.findForPlatform(platform);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function findModuleForFamily(family: DeviceFamily): KnowledgeModule | undefined {
  return defaultRegistry.findForFamily(family);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllDeviceProfiles(): Record<string, DeviceProfileBase> {
  return defaultRegistry.getAllDeviceProfiles();
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllDocEntries(): DocIndexEntry[] {
  return defaultRegistry.getAllDocEntries();
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllPromptFragments(
  filter?: { tier?: string; mode?: string; section?: string },
): PromptFragment[] {
  return defaultRegistry.getAllPromptFragments(filter);
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllCommandPatterns(): CommandPattern[] {
  return defaultRegistry.getAllCommandPatterns();
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAllFailureHints(): FailureHint[] {
  return defaultRegistry.getAllFailureHints();
}

/**
 * @deprecated Use `KnowledgeRegistry` class instance instead.
 * Kept for backward compatibility — delegates to a process-scoped default instance.
 */
export function getAggregatedEcosystemPrompt(): string {
  return defaultRegistry.getAggregatedEcosystemPrompt();
}
