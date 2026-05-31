/**
 * Stable host adapter contract between Moss packages and a product shell.
 *
 * Moss owns agent behavior. The host owns credentials, UI, persistence, native
 * integrations, device access, and product-specific tools. This manifest lets a
 * host state what it provides so a newer Moss bundle can decide whether it can
 * run unchanged, needs a small adapter update, or is incompatible.
 */

/**
 * Contract version for Host Adapter compatibility.
 * Bump this when making breaking changes to the Host Adapter interface.
 * Must match the major version of package.json (e.g., contract v1 = package v1.x.x).
 */
export const MOSS_HOST_ADAPTER_CONTRACT_VERSION = 1;

export type MossHostAdapterContractVersion = number;

export type MossHostCapabilityStability = 'stable' | 'evolving' | 'experimental';

export type MossHostCapabilityKind =
  | 'llm_provider'
  | 'tool_registry'
  | 'approval_gate'
  | 'event_sink'
  | 'workspace'
  | 'memory'
  | 'knowledge'
  | 'prompt_context'
  | 'skill_runtime'
  | 'artifact_runtime'
  | 'device_runtime'
  | 'channel_runtime'
  | 'telemetry';

export interface MossHostPackageRef {
  name: string;
  version: string;
  stability: MossHostCapabilityStability;
}

export interface MossHostProviderRef {
  id: string;
  displayName?: string;
  families: readonly string[];
  configuredByHost: boolean;
  streaming: boolean;
  toolCalling: boolean;
}

export const MOSS_HOST_TOOL_SURFACE_KINDS = [
  'computer_workspace',
  'computer_shell',
  'browser_web',
  'attachment_media',
  'board_device',
  'robotics_runtime',
  'channel_messaging',
  'task_subagent',
  'memory_skill',
  'openclaw_channel',
] as const;

export type MossHostToolSurfaceKind = (typeof MOSS_HOST_TOOL_SURFACE_KINDS)[number];

export const MOSS_HOST_TOOL_RESULT_SURFACES = [
  'assistant_text',
  'timeline_summary',
  'terminal_output',
  'artifact',
  'media_or_file',
  'channel_delivery',
  'background_task',
] as const;

export type MossHostToolResultSurface = (typeof MOSS_HOST_TOOL_RESULT_SURFACES)[number];

export const MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES = [
  'none',
  'event_sink',
  'streaming',
  'background_task',
] as const;

export type MossHostToolSurfaceProgressMode =
  (typeof MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES)[number];

export const MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS = [
  'always_available',
  'workspace_selected',
  'network_enabled',
  'attachment_context',
  'channel_configured',
  'device_selected',
  'device_reachable',
  'robotics_runtime_detected',
  'openclaw_gateway_ready',
  'approval_required',
] as const;

export type MossHostToolSurfaceReadinessSignal =
  (typeof MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS)[number];

export interface MossHostToolSurfaceRef {
  kind: MossHostToolSurfaceKind;
  summary: string;
  readiness: readonly MossHostToolSurfaceReadinessSignal[];
  progressMode: MossHostToolSurfaceProgressMode;
  primaryTools: readonly string[];
  healthTools?: readonly string[];
  fallbackSurfaces?: readonly MossHostToolSurfaceKind[];
  resultSurfaces?: readonly MossHostToolResultSurface[];
}

export interface MossHostToolRef {
  name: string;
  boundaryId: string;
  sideEffectClass:
    | 'readonly'
    | 'local_write'
    | 'device_mutation'
    | 'credential'
    | 'external_message'
    | 'memory_write'
    | 'runtime_state'
    | 'subagent';
  approval: 'not_required' | 'plan_audit' | 'execute_audit';
  source: 'moss' | 'host' | 'extension';
  /**
   * User-visible capability surface this tool contributes to.
   *
   * This is intentionally optional for backward compatibility with Host Adapter
   * v1 manifests. New hosts should set it so Moss can evaluate capability
   * coverage at the level users feel: desktop, board, browser, attachments,
   * channels, background tasks, memory/skills, and channel backplanes.
   */
  surface?: MossHostToolSurfaceKind;
  /** Presentation surface the host uses for this tool result/progress. */
  resultSurface?: MossHostToolResultSurface;
}

export interface MossHostEventSinkRef {
  id: string;
  schemas: readonly string[];
  supportsStreaming: boolean;
}

export interface MossHostKnowledgeRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

export interface MossHostMemoryProviderRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

export interface MossHostSkillStoreRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

export interface MossHostCapabilityRef {
  kind: MossHostCapabilityKind;
  version: string;
  stability: MossHostCapabilityStability;
  summary: string;
  optional?: boolean;
}

export interface MossHostRuntimeManifest {
  schema: 'moss_host_adapter.v1';
  contractVersion: MossHostAdapterContractVersion;
  host: {
    id: string;
    name: string;
    version: string;
  };
  moss: {
    version: string;
    packages: readonly MossHostPackageRef[];
  };
  capabilities: readonly MossHostCapabilityRef[];
  providers: readonly MossHostProviderRef[];
  /**
   * Optional user-visible capability surface inventory.
   *
   * `tools[].surface` proves individual tools are classified. `toolSurfaces`
   * describes the operational contract for each surface: what must be ready,
   * how progress is surfaced, which tools are primary or health checks, and
   * which fallback surfaces are reasonable. Hosts should fill this from real
   * product capabilities rather than copying another product's feature list.
   */
  toolSurfaces?: readonly MossHostToolSurfaceRef[];
  tools: readonly MossHostToolRef[];
  eventSinks: readonly MossHostEventSinkRef[];
  /**
   * Optional long-term-memory source supplied by the host.
   *
   * Memory is user/session-derived state: preferences, durable notes, learned
   * corrections, or workspace facts that may evolve while the agent runs. It is
   * read late in prompt assembly as dynamic context, after stable product and
   * knowledge layers, so fresh user facts can override generic documentation
   * without changing the packaged knowledge module. Hosts should treat memory
   * as mutable, scoped by user/workspace/session policy, and separate from
   * bundled device facts. Memory providers may also expose write tools, but the
   * manifest entry only describes the read/injection capability.
   */
  memoryProvider?: MossHostMemoryProviderRef;
  /**
   * Domain knowledge modules registered by the host.
   *
   * Knowledge is packaged, provenance-bearing domain data: device profiles,
   * documentation references, command patterns, failure hints, and endorsed
   * skills. Moss injects knowledge before memory and before per-turn context,
   * using module conflict rules and platform matching rather than recency. A
   * module should be versioned with the host release or remote knowledge bundle
   * that supplied it. Use this axis for facts a new agent instance should know
   * consistently; use memory for user-specific learned state and tools or
   * extensions for executable behavior.
   */
  knowledgeModules: readonly MossHostKnowledgeRef[];
  /**
   * Optional host skill catalog/runtime.
   *
   * Skills are procedural instructions or recipes that help the agent decide
   * how to act, but they are not device facts and should not be used as durable
   * user memory. Hosts usually load skill metadata during routing, then inject
   * only the matched skill bodies for the current task. Skill context is merged
   * after stable knowledge but before final per-turn hints, and may contribute
   * tools or commands through the normal tool/approval boundary. Use this axis
   * when a host can discover, install, validate, or execute reusable procedures.
   */
  skillStore?: MossHostSkillStoreRef;
}

export interface MossHostCompatibilityRequirement {
  minHostVersion?: string;
  contractVersion?: MossHostAdapterContractVersion;
  minContractVersion?: MossHostAdapterContractVersion;
  maxContractVersion?: MossHostAdapterContractVersion;
  requiredCapabilities?: readonly MossHostCapabilityKind[];
  requiredToolSurfaces?: readonly MossHostToolSurfaceKind[];
  requiredToolSurfaceDetails?: readonly MossHostToolSurfaceKind[];
  requiredEventSchemas?: readonly string[];
  requiredProviderFamilies?: readonly string[];
}

export type MossHostCompatibilityStatus =
  | 'ok'
  | 'invalid_manifest'
  | 'host_version_incompatible'
  | 'contract_mismatch'
  | 'missing_capability'
  | 'missing_event_schema'
  | 'missing_provider_family';

export interface MossHostCompatibilityReport {
  compatible: boolean;
  status: MossHostCompatibilityStatus;
  reasons: readonly string[];
  missingCapabilities: readonly MossHostCapabilityKind[];
  missingToolSurfaces: readonly MossHostToolSurfaceKind[];
  missingToolSurfaceDetails: readonly MossHostToolSurfaceKind[];
  missingEventSchemas: readonly string[];
  missingProviderFamilies: readonly string[];
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function validateMossHostManifestShape(manifest: unknown): string | null {
  if (!isRecord(manifest)) return 'manifest must be an object';
  if (manifest.schema !== 'moss_host_adapter.v1') {
    return 'manifest.schema must be moss_host_adapter.v1';
  }
  if (typeof manifest.contractVersion !== 'number') {
    return 'manifest.contractVersion must be a number';
  }

  if (!isRecord(manifest.host)) return 'manifest.host must be an object';
  if (
    typeof manifest.host.id !== 'string' ||
    typeof manifest.host.name !== 'string' ||
    typeof manifest.host.version !== 'string'
  ) {
    return 'manifest.host must include string id, name, and version';
  }

  if (!isRecord(manifest.moss)) return 'manifest.moss must be an object';
  if (typeof manifest.moss.version !== 'string' || !Array.isArray(manifest.moss.packages)) {
    return 'manifest.moss must include string version and packages array';
  }

  if (!Array.isArray(manifest.capabilities)) return 'manifest.capabilities must be an array';
  if (
    manifest.capabilities.some(
      (capability) =>
        !isRecord(capability) ||
        typeof capability.kind !== 'string' ||
        typeof capability.version !== 'string' ||
        typeof capability.stability !== 'string' ||
        typeof capability.summary !== 'string',
    )
  ) {
    return 'manifest.capabilities must be an array of capability records';
  }

  if (!Array.isArray(manifest.providers)) return 'manifest.providers must be an array';
  if (
    manifest.providers.some(
      (provider) =>
        !isRecord(provider) ||
        typeof provider.id !== 'string' ||
        !isStringArray(provider.families) ||
        typeof provider.configuredByHost !== 'boolean' ||
        typeof provider.streaming !== 'boolean' ||
        typeof provider.toolCalling !== 'boolean',
    )
  ) {
    return 'manifest.providers must be an array of provider records';
  }

  if (!Array.isArray(manifest.tools)) return 'manifest.tools must be an array';
  if (
    manifest.tools.some(
      (tool) =>
        !isRecord(tool) ||
        typeof tool.name !== 'string' ||
        typeof tool.boundaryId !== 'string' ||
        typeof tool.sideEffectClass !== 'string' ||
        typeof tool.approval !== 'string' ||
        typeof tool.source !== 'string',
    )
  ) {
    return 'manifest.tools must be an array of tool records';
  }
  for (const tool of manifest.tools) {
    if (!isRecord(tool)) continue;
    if (tool.surface !== undefined && !isOneOf(tool.surface, MOSS_HOST_TOOL_SURFACE_KINDS)) {
      return 'manifest.tools[].surface must be a known tool surface';
    }
    if (
      tool.resultSurface !== undefined &&
      !isOneOf(tool.resultSurface, MOSS_HOST_TOOL_RESULT_SURFACES)
    ) {
      return 'manifest.tools[].resultSurface must be a known result surface';
    }
  }

  if (manifest.toolSurfaces !== undefined) {
    if (!Array.isArray(manifest.toolSurfaces)) {
      return 'manifest.toolSurfaces must be an array when present';
    }
    for (const surface of manifest.toolSurfaces) {
      if (!isRecord(surface)) {
        return 'manifest.toolSurfaces must be an array of surface records';
      }
      if (!isOneOf(surface.kind, MOSS_HOST_TOOL_SURFACE_KINDS)) {
        return 'manifest.toolSurfaces[].kind must be a known tool surface';
      }
      if (typeof surface.summary !== 'string') {
        return 'manifest.toolSurfaces[].summary must be a string';
      }
      if (
        !Array.isArray(surface.readiness) ||
        !surface.readiness.every((item) => isOneOf(item, MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS))
      ) {
        return 'manifest.toolSurfaces[].readiness must contain known readiness signals';
      }
      if (!isOneOf(surface.progressMode, MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES)) {
        return 'manifest.toolSurfaces[].progressMode must be a known progress mode';
      }
      if (!isStringArray(surface.primaryTools)) {
        return 'manifest.toolSurfaces[].primaryTools must be a string array';
      }
      if (surface.healthTools !== undefined && !isStringArray(surface.healthTools)) {
        return 'manifest.toolSurfaces[].healthTools must be a string array';
      }
      if (
        surface.fallbackSurfaces !== undefined &&
        (
          !Array.isArray(surface.fallbackSurfaces) ||
          !surface.fallbackSurfaces.every((item) => isOneOf(item, MOSS_HOST_TOOL_SURFACE_KINDS))
        )
      ) {
        return 'manifest.toolSurfaces[].fallbackSurfaces must contain known tool surfaces';
      }
      if (
        surface.resultSurfaces !== undefined &&
        (
          !Array.isArray(surface.resultSurfaces) ||
          !surface.resultSurfaces.every((item) => isOneOf(item, MOSS_HOST_TOOL_RESULT_SURFACES))
        )
      ) {
        return 'manifest.toolSurfaces[].resultSurfaces must contain known result surfaces';
      }
    }
  }

  if (!Array.isArray(manifest.eventSinks)) return 'manifest.eventSinks must be an array';
  if (
    manifest.eventSinks.some(
      (sink) =>
        !isRecord(sink) ||
        typeof sink.id !== 'string' ||
        !isStringArray(sink.schemas) ||
        typeof sink.supportsStreaming !== 'boolean',
    )
  ) {
    return 'manifest.eventSinks must be an array of event sink records';
  }

  if (!Array.isArray(manifest.knowledgeModules)) {
    return 'manifest.knowledgeModules must be an array';
  }
  if (
    manifest.knowledgeModules.some(
      (km) =>
        !isRecord(km) ||
        typeof km.id !== 'string' ||
        typeof km.version !== 'string' ||
        typeof km.stability !== 'string',
    )
  ) {
    return 'manifest.knowledgeModules must be an array of knowledge module records';
  }

  return null;
}

function emptyFailureReport(
  status: Exclude<MossHostCompatibilityStatus, 'ok'>,
  reasons: readonly string[],
): MossHostCompatibilityReport {
  return {
    compatible: false,
    status,
    reasons,
    missingCapabilities: [],
    missingToolSurfaces: [],
    missingToolSurfaceDetails: [],
    missingEventSchemas: [],
    missingProviderFamilies: [],
  };
}

export function evaluateMossHostCompatibility(
  manifest: unknown,
  requirement: MossHostCompatibilityRequirement = {},
): MossHostCompatibilityReport {
  const reasons: string[] = [];
  const invalidManifestReason = validateMossHostManifestShape(manifest);

  if (invalidManifestReason) {
    reasons.push(invalidManifestReason);
    return emptyFailureReport('invalid_manifest', reasons);
  }

  const runtimeManifest = manifest as MossHostRuntimeManifest;

  if (requirement.contractVersion !== undefined) {
    if (runtimeManifest.contractVersion !== requirement.contractVersion) {
      reasons.push(
        `host adapter contract v${runtimeManifest.contractVersion} does not match Moss requirement v${requirement.contractVersion}`,
      );
      return emptyFailureReport('contract_mismatch', reasons);
    }
  } else if (
    requirement.minContractVersion !== undefined ||
    requirement.maxContractVersion !== undefined
  ) {
    const minContractVersion = requirement.minContractVersion ?? Number.NEGATIVE_INFINITY;
    const maxContractVersion = requirement.maxContractVersion ?? Number.POSITIVE_INFINITY;
    if (
      runtimeManifest.contractVersion < minContractVersion ||
      runtimeManifest.contractVersion > maxContractVersion
    ) {
      reasons.push(
        `host adapter contract v${runtimeManifest.contractVersion} is outside Moss requirement range ${minContractVersion}..${maxContractVersion}`,
      );
      return emptyFailureReport('contract_mismatch', reasons);
    }
  } else if (runtimeManifest.contractVersion !== MOSS_HOST_ADAPTER_CONTRACT_VERSION) {
    reasons.push(
      `host adapter contract v${runtimeManifest.contractVersion} does not match Moss requirement v${MOSS_HOST_ADAPTER_CONTRACT_VERSION}`,
    );
    return emptyFailureReport('contract_mismatch', reasons);
  }

  if (
    requirement.minHostVersion &&
    compareSemver(runtimeManifest.host.version, requirement.minHostVersion) < 0
  ) {
    reasons.push(
      `host ${runtimeManifest.host.version} is older than required ${requirement.minHostVersion}`,
    );
    return {
      compatible: false,
      status: 'host_version_incompatible',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const capabilityKinds = new Set(
    runtimeManifest.capabilities.map((capability) => capability.kind),
  );
  const missingCapabilities = (requirement.requiredCapabilities ?? []).filter(
    (kind) => !capabilityKinds.has(kind),
  );
  if (missingCapabilities.length > 0) {
    reasons.push(`missing host capabilities: ${missingCapabilities.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities,
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const toolSurfaces = new Set(
    runtimeManifest.tools.flatMap((tool) => (tool.surface ? [tool.surface] : [])),
  );
  const missingToolSurfaces = (requirement.requiredToolSurfaces ?? []).filter(
    (surface) => !toolSurfaces.has(surface),
  );
  if (missingToolSurfaces.length > 0) {
    reasons.push(`missing host tool surfaces: ${missingToolSurfaces.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces,
      missingToolSurfaceDetails: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const toolSurfaceDetails = new Set(
    (runtimeManifest.toolSurfaces ?? []).map((surface) => surface.kind),
  );
  const missingToolSurfaceDetails = (requirement.requiredToolSurfaceDetails ?? []).filter(
    (surface) => !toolSurfaceDetails.has(surface),
  );
  if (missingToolSurfaceDetails.length > 0) {
    reasons.push(`missing host tool surface details: ${missingToolSurfaceDetails.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails,
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const eventSchemas = new Set(runtimeManifest.eventSinks.flatMap((sink) => [...sink.schemas]));
  const missingEventSchemas = (requirement.requiredEventSchemas ?? []).filter(
    (schema) => !eventSchemas.has(schema),
  );
  if (missingEventSchemas.length > 0) {
    reasons.push(`missing host event schemas: ${missingEventSchemas.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_event_schema',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingEventSchemas,
      missingProviderFamilies: [],
    };
  }

  const providerFamilies = new Set(
    runtimeManifest.providers.flatMap((provider) => [...provider.families]),
  );
  const missingProviderFamilies = (requirement.requiredProviderFamilies ?? []).filter(
    (family) => !providerFamilies.has(family),
  );
  if (missingProviderFamilies.length > 0) {
    reasons.push(`missing host provider families: ${missingProviderFamilies.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_provider_family',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingEventSchemas: [],
      missingProviderFamilies,
    };
  }

  return {
    compatible: true,
    status: 'ok',
    reasons,
    missingCapabilities: [],
    missingToolSurfaces: [],
    missingToolSurfaceDetails: [],
    missingEventSchemas: [],
    missingProviderFamilies: [],
  };
}
