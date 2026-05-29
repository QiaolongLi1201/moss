/**
 * Platform Extension Registry — manages the lifecycle of platform extensions.
 *
 * Extensions bundle: KnowledgeModule + VendorPlugin.
 * When enabled, their knowledge and vendor contributions are registered;
 * when disabled, they are unregistered.
 *
 * Module-level free functions are deprecated backward-compat wrappers that
 * delegate to a shared singleton instance.
 */

import type { DmossVendorPlugin } from '@rdk-moss/core';
import type { DmossPlatformExtension } from '@rdk-moss/core';
import type { KnowledgeRegistry } from '../knowledge/registry.js';
import {
  bridgeGlobalKnowledgeModuleForExtension,
  unbridgeGlobalKnowledgeModuleForExtension,
} from '../knowledge/registry.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('extensions');

export interface VendorPluginCallbacks<THostTool = unknown> {
  register(plugin: DmossVendorPlugin<THostTool>): void;
  unregister(id: string): void;
}

export class PlatformExtensionRegistry {
  private vendorCallbacks: VendorPluginCallbacks | null = null;
  private knowledgeRegistry: KnowledgeRegistry | null = null;
  private lastApplied = new Map<string, boolean>();
  private cachedExtensions: DmossPlatformExtension[] = [];

  setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
    this.vendorCallbacks = callbacks;
  }

  setKnowledgeRegistry(registry: KnowledgeRegistry): void {
    this.knowledgeRegistry = registry;
  }

  apply(ext: DmossPlatformExtension): void {
    const want = ext.isEnabled();
    const prev = this.lastApplied.get(ext.id);
    if (prev === want && prev !== undefined) return;

    if (!want) {
      this.knowledgeRegistry?.unregister(ext.knowledgeModuleId);
      this.vendorCallbacks?.unregister(ext.vendorPluginId);
      this.lastApplied.set(ext.id, false);
      return;
    }

    this.knowledgeRegistry?.register(ext.getKnowledgeModule());
    this.vendorCallbacks?.register(ext.getVendorPlugin());
    this.lastApplied.set(ext.id, true);
  }

  applyForce(ext: DmossPlatformExtension): void {
    this.lastApplied.delete(ext.id);
    this.apply(ext);
  }

  reset(): void {
    this.lastApplied.clear();
  }

  listAppliedState(): ReadonlyMap<string, boolean> {
    return this.lastApplied;
  }

  setExtensionsSnapshot(exts: readonly DmossPlatformExtension[]): void {
    this.cachedExtensions = [...exts];
  }

  getExtensions(): readonly DmossPlatformExtension[] {
    return this.cachedExtensions;
  }

  syncAtStartup(factories: Array<() => DmossPlatformExtension>): void {
    const instances: DmossPlatformExtension[] = [];
    for (const factory of factories) {
      const ext = factory();
      instances.push(ext);
      this.apply(ext);
    }
    this.setExtensionsSnapshot(instances);
  }

  /** @internal Copy compatibility-only state from the deprecated singleton. */
  copyCompatibilityStateFrom(source: PlatformExtensionRegistry): void {
    this.vendorCallbacks = source.vendorCallbacks;
    this.cachedExtensions = [...source.cachedExtensions];
  }
}

let _defaultRegistry: PlatformExtensionRegistry | null = null;

function getDefault(): PlatformExtensionRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new PlatformExtensionRegistry();
  }
  return _defaultRegistry;
}

/**
 * Returns the process-scoped PlatformExtensionRegistry that backs deprecated
 * free-function wrappers such as `applyPlatformExtension()`.
 *
 * DmossAgent instances own private PlatformExtensionRegistry instances. This
 * singleton remains available only for legacy hosts that still use the
 * deprecated wrapper API during migration.
 */
export function getDefaultExtensionsRegistry(): PlatformExtensionRegistry {
  return getDefault();
}

/** @internal Create a per-agent extension registry seeded from legacy defaults. */
export function createAgentExtensionRegistryFromDefaults(): PlatformExtensionRegistry {
  const registry = new PlatformExtensionRegistry();
  registry.copyCompatibilityStateFrom(getDefault());
  return registry;
}

/** @internal Reset deprecated-wrapper warning state — tests only. */
export function resetExtensionsWireCountForTests(): void {
  _deprecatedWarnedFunctions.clear();
}

const _deprecatedWarnedFunctions = new Set<string>();

function warnDeprecated(name: string): void {
  if (_deprecatedWarnedFunctions.has(name)) return;
  _deprecatedWarnedFunctions.add(name);
  log.warn(
    `Deprecated extension free function "${name}" called. ` +
    'Migrate to agent.extensions.* for per-agent isolation. ' +
    'See ARCHITECTURE_ASSESSMENT.md P0-1.',
  );
}

function bridgeDefaultExtensionKnowledge(ext: DmossPlatformExtension): void {
  if (ext.isEnabled()) {
    bridgeGlobalKnowledgeModuleForExtension(ext.getKnowledgeModule());
  } else {
    unbridgeGlobalKnowledgeModuleForExtension(ext.knowledgeModuleId);
  }
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.setVendorPluginCallbacks()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
  warnDeprecated('setVendorPluginCallbacks');
  getDefault().setVendorPluginCallbacks(callbacks);
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.setKnowledgeRegistry()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function setKnowledgeRegistryForExtensions(registry: KnowledgeRegistry): void {
  warnDeprecated('setKnowledgeRegistryForExtensions');
  getDefault().setKnowledgeRegistry(registry);
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.apply()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function applyPlatformExtension(ext: DmossPlatformExtension): void {
  warnDeprecated('applyPlatformExtension');
  getDefault().apply(ext);
  bridgeDefaultExtensionKnowledge(ext);
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.applyForce()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function applyPlatformExtensionForce(ext: DmossPlatformExtension): void {
  warnDeprecated('applyPlatformExtensionForce');
  getDefault().applyForce(ext);
  bridgeDefaultExtensionKnowledge(ext);
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.reset()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function resetPlatformExtensionRegistryForTests(): void {
  getDefault().reset();
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.listAppliedState()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function listAppliedPlatformExtensionState(): ReadonlyMap<string, boolean> {
  return getDefault().listAppliedState();
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.setExtensionsSnapshot()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function setRegisteredPlatformExtensionsSnapshot(
  exts: readonly DmossPlatformExtension[],
): void {
  getDefault().setExtensionsSnapshot(exts);
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.getExtensions()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function getRegisteredPlatformExtensions(): readonly DmossPlatformExtension[] {
  return getDefault().getExtensions();
}

/** @deprecated since 0.4.0, removal target 1.0. Use `agent.extensions.syncAtStartup()` instead. See [MIGRATION.md](../MIGRATION.md) for code examples. */
export function syncPlatformExtensionsAtStartup(
  factories: Array<() => DmossPlatformExtension>,
): void {
  warnDeprecated('syncPlatformExtensionsAtStartup');
  const instances: DmossPlatformExtension[] = [];
  for (const factory of factories) {
    const ext = factory();
    instances.push(ext);
    getDefault().apply(ext);
    bridgeDefaultExtensionKnowledge(ext);
  }
  getDefault().setExtensionsSnapshot(instances);
}
