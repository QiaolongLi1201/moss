/**
 * D-Moss Platform Extension — the primary integration point for adding
 * new hardware platforms (e.g. Jetson, Raspberry Pi, custom boards) to D-Moss.
 *
 * A platform extension bundles:
 *  - Identity metadata (id, version, linked module IDs)
 *  - Activation logic (isEnabled)
 *  - A KnowledgeModule (domain knowledge, device profiles, prompts)
 *  - A VendorPlugin (prompt contributions, optional tool contributions)
 *
 * Generic parameter `THostTool` allows the host to bind its own Tool type.
 */

import type { DeviceFamily } from './device-family.js';
import type { KnowledgeModule } from './knowledge-module.js';
import type { DmossVendorPlugin, DmossToolContributor } from './vendor-plugin.js';

/**
 * Stable identity fields — shared between core contract and host implementation.
 */
export interface DmossPlatformExtensionIdentities {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  /** Must match the KnowledgeModule.id registered in the knowledge registry */
  readonly knowledgeModuleId: string;
  /** Must match the VendorPlugin.id registered in the vendor registry */
  readonly vendorPluginId: string;
  /**
   * Optional device family this extension primarily targets. Used by
   * `platform-extension-catalog.getExtensionByFamily()` for fast routing
   * (e.g. "connected device has family=jetson, which extension owns it?").
   *
   * Resolution policy when multiple extensions declare the same family:
   * `first-wins` — the extension earlier in registration order takes
   * precedence. Future versions may introduce priority if conflicts
   * become common.
   *
   * Leaving this `undefined` is legal: the extension then reachable only
   * via `getRegisteredPlatformExtensions()`, not via family routing.
   */
  readonly family?: DeviceFamily;
}

/**
 * Full platform extension interface — host implements this to plug in
 * a new hardware ecosystem.
 */
export interface DmossPlatformExtension<THostTool = unknown>
  extends DmossPlatformExtensionIdentities {
  /** Whether this extension is active (typically driven by env vars or config) */
  isEnabled(): boolean;

  /** The knowledge module providing device profiles, prompts, failure hints, etc. */
  getKnowledgeModule(): KnowledgeModule;

  /** Vendor plugin providing prompt layers and optional tool contributions */
  getVendorPlugin(): DmossVendorPlugin<THostTool>;

  /** Optional extra device tool contributors beyond the vendor plugin */
  getExtraDeviceToolContributors?(): DmossToolContributor<THostTool>[];
}
