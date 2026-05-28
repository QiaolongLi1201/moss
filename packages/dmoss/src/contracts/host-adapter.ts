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
      missingEventSchemas: [],
      missingProviderFamilies,
    };
  }

  return {
    compatible: true,
    status: 'ok',
    reasons,
    missingCapabilities: [],
    missingEventSchemas: [],
    missingProviderFamilies: [],
  };
}
