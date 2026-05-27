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

import type { DmossVendorPlugin } from '@dmoss/core';
import type { DmossPlatformExtension } from '@dmoss/core';
import { KnowledgeRegistry } from '../knowledge/registry.js';
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
}

let _defaultRegistry: PlatformExtensionRegistry | null = null;
let _agentWireCount = 0;

function getDefault(): PlatformExtensionRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new PlatformExtensionRegistry();
  }
  return _defaultRegistry;
}

/**
 * Returns the shared default PlatformExtensionRegistry instance.
 *
 * **Single-instance bridge.** All DmossAgent instances in the same process
 * share this registry. Hosts that run multiple DmossAgent instances in one
 * process MUST migrate to `agent.extensions.*` for true isolation — the
 * last agent to call `setKnowledgeRegistry()` overwrites the previous one's
 * knowledge binding for all extension apply/force operations.
 *
 * A one-time warning is logged when a second agent wires to this singleton,
 * making the migration pressure visible.
 */
export function getDefaultExtensionsRegistry(): PlatformExtensionRegistry {
  _agentWireCount++;
  if (_agentWireCount === 2) {
    log.warn(
      'Multiple DmossAgent instances sharing PlatformExtensionRegistry singleton. ' +
      'Extension knowledge bindings are NOT isolated — last agent wins. ' +
      'Migrate to agent.extensions.* for per-agent isolation.',
    );
  }
  return getDefault();
}

/** @internal Reset wire counter — tests only. */
export function resetExtensionsWireCountForTests(): void {
  _agentWireCount = 0;
  _deprecatedWarned = false;
}

let _deprecatedWarned = false;

function warnDeprecated(name: string): void {
  if (_deprecatedWarned) return;
  _deprecatedWarned = true;
  log.warn(
    `Deprecated extension free function "${name}" called. ` +
    'Migrate to agent.extensions.* for per-agent isolation. ' +
    'See ARCHITECTURE_ASSESSMENT.md P0-1.',
  );
}

/** @deprecated Use `agent.extensions.setVendorPluginCallbacks()` instead. */
export function setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
  warnDeprecated('setVendorPluginCallbacks');
  getDefault().setVendorPluginCallbacks(callbacks);
}

/** @deprecated Use `agent.extensions.setKnowledgeRegistry()` instead. */
export function setKnowledgeRegistryForExtensions(registry: KnowledgeRegistry): void {
  warnDeprecated('setKnowledgeRegistryForExtensions');
  getDefault().setKnowledgeRegistry(registry);
}

/** @deprecated Use `agent.extensions.apply()` instead. */
export function applyPlatformExtension(ext: DmossPlatformExtension): void {
  warnDeprecated('applyPlatformExtension');
  getDefault().apply(ext);
}

/** @deprecated Use `agent.extensions.applyForce()` instead. */
export function applyPlatformExtensionForce(ext: DmossPlatformExtension): void {
  warnDeprecated('applyPlatformExtensionForce');
  getDefault().applyForce(ext);
}

/** @deprecated Use `agent.extensions.reset()` instead. */
export function resetPlatformExtensionRegistryForTests(): void {
  getDefault().reset();
}

/** @deprecated Use `agent.extensions.listAppliedState()` instead. */
export function listAppliedPlatformExtensionState(): ReadonlyMap<string, boolean> {
  return getDefault().listAppliedState();
}

/** @deprecated Use `agent.extensions.setExtensionsSnapshot()` instead. */
export function setRegisteredPlatformExtensionsSnapshot(
  exts: readonly DmossPlatformExtension[],
): void {
  getDefault().setExtensionsSnapshot(exts);
}

/** @deprecated Use `agent.extensions.getExtensions()` instead. */
export function getRegisteredPlatformExtensions(): readonly DmossPlatformExtension[] {
  return getDefault().getExtensions();
}

/** @deprecated Use `agent.extensions.syncAtStartup()` instead. */
export function syncPlatformExtensionsAtStartup(
  factories: Array<() => DmossPlatformExtension>,
): void {
  warnDeprecated('syncPlatformExtensionsAtStartup');
  getDefault().syncAtStartup(factories);
}
