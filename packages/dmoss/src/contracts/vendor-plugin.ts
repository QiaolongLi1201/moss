/**
 * D-Moss Vendor / Extension Plugin Contracts.
 *
 * These interfaces define how hardware vendors contribute prompts and tools
 * to the D-Moss Agent without modifying the agent core.
 *
 * Zero host dependencies — the `THostTool` generic allows any tool type system.
 */

/**
 * Contributes prompt layers to the system prompt.
 *
 * Stable layers are cached and rarely change (e.g. brand positioning).
 * Dynamic layers are rebuilt per request (e.g. device-specific context).
 */
export interface DmossPromptContributor {
  readonly id: string;
  /** Prompt lines that rarely change (cached aggressively) */
  buildStableLayers?(): string[];
  /** Prompt lines rebuilt per request (device state, session context) */
  buildDynamicLayers?(): string[];
}

/**
 * Contributes tools to the agent for a specific device or globally.
 *
 * @typeParam THostTool - The host application's tool type (e.g. Anthropic Tool, custom Tool)
 */
export interface DmossToolContributor<THostTool = unknown> {
  readonly id: string;
  /**
   * Create tools, optionally scoped to a connected device.
   * @param deviceId - Connected device ID, or `undefined` for global tools
   */
  createTools(deviceId: string | undefined): THostTool[];
}

/**
 * A vendor plugin bundles prompt and tool contributions under a single identity.
 *
 * Registered via `DmossPlatformExtension.getVendorPlugin()` or directly
 * through the vendor plugin registry.
 *
 * @typeParam THostTool - The host application's tool type
 */
export interface DmossVendorPlugin<THostTool = unknown> {
  readonly id: string;
  readonly displayName: string;
  /** Prompt contributors for system prompt injection */
  promptContributors?: DmossPromptContributor[];
  /** Tool contributors for device-scoped or global tools */
  toolContributors?: DmossToolContributor<THostTool>[];
}
