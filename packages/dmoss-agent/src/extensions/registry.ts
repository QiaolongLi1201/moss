/**
 * Platform Extension Registry — manages the lifecycle of platform extensions.
 *
 * Extensions bundle: KnowledgeModule + VendorPlugin.
 * When enabled, their knowledge and vendor contributions are registered;
 * when disabled, they are unregistered.
 */

import type { DmossVendorPlugin } from '@dmoss/core';
import type { DmossPlatformExtension } from '@dmoss/core';
import { KnowledgeRegistry } from '../knowledge/registry.js';

export interface VendorPluginCallbacks<THostTool = unknown> {
  register(plugin: DmossVendorPlugin<THostTool>): void;
  unregister(id: string): void;
}

let vendorCallbacks: VendorPluginCallbacks | null = null;

/** Host must call this at startup to wire vendor plugin registration */
export function setVendorPluginCallbacks(callbacks: VendorPluginCallbacks): void {
  vendorCallbacks = callbacks;
}

let _knowledgeRegistry: KnowledgeRegistry | null = null;

/**
 * Set the KnowledgeRegistry instance for platform extension registration.
 * When set, extensions register/unregister knowledge modules directly on
 * this instance instead of the deprecated global bridge.
 */
export function setKnowledgeRegistryForExtensions(registry: KnowledgeRegistry): void {
  _knowledgeRegistry = registry;
}

const lastApplied = new Map<string, boolean>();

export function applyPlatformExtension(ext: DmossPlatformExtension): void {
  const want = ext.isEnabled();
  const prev = lastApplied.get(ext.id);
  if (prev === want && prev !== undefined) return;

  if (!want) {
    if (_knowledgeRegistry) {
      _knowledgeRegistry.unregister(ext.knowledgeModuleId);
    }
    vendorCallbacks?.unregister(ext.vendorPluginId);
    lastApplied.set(ext.id, false);
    return;
  }

  if (_knowledgeRegistry) {
    _knowledgeRegistry.register(ext.getKnowledgeModule());
  }
  vendorCallbacks?.register(ext.getVendorPlugin());
  lastApplied.set(ext.id, true);
}

export function applyPlatformExtensionForce(ext: DmossPlatformExtension): void {
  lastApplied.delete(ext.id);
  applyPlatformExtension(ext);
}

export function resetPlatformExtensionRegistryForTests(): void {
  lastApplied.clear();
}

export function listAppliedPlatformExtensionState(): ReadonlyMap<string, boolean> {
  return lastApplied;
}

let cachedExtensions: DmossPlatformExtension[] = [];

export function setRegisteredPlatformExtensionsSnapshot(
  exts: readonly DmossPlatformExtension[],
): void {
  cachedExtensions = [...exts];
}

export function getRegisteredPlatformExtensions(): readonly DmossPlatformExtension[] {
  return cachedExtensions;
}

/**
 * Bootstrap all provided extension factories — the host passes its extension list here.
 */
export function syncPlatformExtensionsAtStartup(
  factories: Array<() => DmossPlatformExtension>,
): void {
  const instances: DmossPlatformExtension[] = [];
  for (const factory of factories) {
    const ext = factory();
    instances.push(ext);
    applyPlatformExtension(ext);
  }
  setRegisteredPlatformExtensionsSnapshot(instances);
}
