export {
  applyPlatformExtension,
  applyPlatformExtensionForce,
  syncPlatformExtensionsAtStartup,
  setVendorPluginCallbacks,
  getRegisteredPlatformExtensions,
  setRegisteredPlatformExtensionsSnapshot,
  resetPlatformExtensionRegistryForTests,
  listAppliedPlatformExtensionState,
} from './registry.js';
export type { VendorPluginCallbacks } from './registry.js';

export type {
  DmossPlatformExtension,
  DmossPlatformExtensionIdentities,
} from '@dmoss/core';
