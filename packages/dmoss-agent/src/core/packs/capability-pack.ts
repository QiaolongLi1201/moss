/**
 * Capability Pack — a portable bundle of tools + prompt layers a host mounts
 * onto a DmossAgent at construction time.
 *
 * Background: Moss already had a per-spawn-scope notion of "a named set of
 * tools + a prompt addon" (see `subagent/spawn-profile.ts`). A capability pack
 * lifts that idea to the *main* agent. A pack declares:
 *  - the tools it contributes (`buildTools`),
 *  - the system-prompt layers that teach the model how to use them
 *    (`promptLayers`), and
 *  - the host-adapter capability kinds it expects the host to provide
 *    (`requiredHostCapabilities`).
 *
 * The same pack can be mounted by any host — RDK Studio, a CLI/TUI on a PC or a
 * board, or another embedding product — so a Moss agent carries the same
 * capability surface across deployments instead of each host re-gluing its own
 * tools and prompts. This file is the *contract* plus a *pure collector*. The
 * runtime reader lives in `DmossAgent`: when `capabilityPacks` is set, the
 * constructor registers each pack's tools as a group, injects its prompt layers
 * into `buildSystemPrompt`, and exposes its host requirements through
 * `getCapabilityPackRequirements()`.
 *
 * Out of scope for this primitive (deferred with trigger): expanding sub-agent
 * spawn scopes from a pack. That needs merge-capable spawn-extension semantics
 * (the current `registerSpawnToolExtensions` replaces rather than merges); add
 * it when a concrete pack needs to widen sub-agent tool scopes.
 */

import type { Tool } from '../tools/tool-types.js';
import type { ToolGroup } from '../tools/tool-registry.js';

export interface CapabilityPack {
  /**
   * Stable identifier, e.g. `"computer"`. Doubles as the tool group id, so it
   * must be unique across the packs mounted on one agent.
   */
  id: string;
  /** Human-readable name for diagnostics. Defaults to `id` when omitted. */
  displayName?: string;
  /**
   * Build the tool instances this pack contributes. Called once when the pack
   * is mounted. A pack may omit this (prompt-only pack).
   */
  buildTools?(): Tool[];
  /**
   * System-prompt layers contributed by this pack — domain guidance and tool
   * usage policy. Empty/whitespace layers are dropped.
   */
  promptLayers?: readonly string[];
  /**
   * Host-adapter capability kinds this pack expects the host to provide
   * (e.g. `"workspace"`, `"approval_gate"`). Declaration only: hosts read
   * `DmossAgent.getCapabilityPackRequirements()` and cross-check them against
   * their own `MossHostRuntimeManifest`.
   */
  requiredHostCapabilities?: readonly string[];
}

export interface CapabilityPackContributions {
  /** One tool group per pack that contributes tools (packs with no tools are skipped). */
  toolGroups: ToolGroup[];
  /** Prompt layers concatenated in pack order. */
  promptLayers: string[];
  /** Deduped, order-preserving union of declared host capability requirements. */
  requiredHostCapabilities: string[];
}

/**
 * Pure collector: flatten a list of packs into the tool groups, prompt layers,
 * and host requirements an agent should apply. No agent or side effects — the
 * runtime application happens in `DmossAgent`.
 *
 * Throws on an empty/non-string pack id or a duplicate id, because a duplicate
 * id would silently clobber a previously registered tool group.
 */
export function collectCapabilityPacks(
  packs: readonly CapabilityPack[],
): CapabilityPackContributions {
  const toolGroups: ToolGroup[] = [];
  const promptLayers: string[] = [];
  const requiredHostCapabilities: string[] = [];
  const seenRequirements = new Set<string>();
  const seenPackIds = new Set<string>();

  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || pack.id.length === 0) {
      throw new Error('CapabilityPack requires a non-empty string id');
    }
    if (seenPackIds.has(pack.id)) {
      throw new Error(`Duplicate CapabilityPack id: ${pack.id}`);
    }
    seenPackIds.add(pack.id);

    const tools = pack.buildTools?.() ?? [];
    if (tools.length > 0) {
      toolGroups.push({
        id: pack.id,
        displayName: pack.displayName ?? pack.id,
        tools,
      });
    }

    for (const layer of pack.promptLayers ?? []) {
      if (typeof layer === 'string' && layer.trim().length > 0) {
        promptLayers.push(layer);
      }
    }

    for (const cap of pack.requiredHostCapabilities ?? []) {
      if (typeof cap === 'string' && cap.length > 0 && !seenRequirements.has(cap)) {
        seenRequirements.add(cap);
        requiredHostCapabilities.push(cap);
      }
    }
  }

  return { toolGroups, promptLayers, requiredHostCapabilities };
}
