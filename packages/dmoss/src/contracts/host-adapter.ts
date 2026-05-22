/**
 * Stable host adapter contract between Moss packages and a product shell.
 *
 * Moss owns agent behavior. The host owns credentials, UI, persistence, native
 * integrations, device access, and product-specific tools. This manifest lets a
 * host state what it provides so a newer Moss bundle can decide whether it can
 * run unchanged, needs a small adapter update, or is incompatible.
 */

export const MOSS_HOST_ADAPTER_CONTRACT_VERSION = 1;

export type MossHostAdapterContractVersion = typeof MOSS_HOST_ADAPTER_CONTRACT_VERSION;

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
  knowledgeModules: readonly MossHostKnowledgeRef[];
}

export interface MossHostCompatibilityRequirement {
  minHostVersion?: string;
  contractVersion?: MossHostAdapterContractVersion;
  requiredCapabilities?: readonly MossHostCapabilityKind[];
  requiredEventSchemas?: readonly string[];
  requiredProviderFamilies?: readonly string[];
}

export type MossHostCompatibilityStatus =
  | 'ok'
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

export function evaluateMossHostCompatibility(
  manifest: MossHostRuntimeManifest,
  requirement: MossHostCompatibilityRequirement = {},
): MossHostCompatibilityReport {
  const expectedContractVersion =
    requirement.contractVersion ?? MOSS_HOST_ADAPTER_CONTRACT_VERSION;
  const reasons: string[] = [];

  if (manifest.contractVersion !== expectedContractVersion) {
    reasons.push(
      `host adapter contract v${manifest.contractVersion} does not match Moss requirement v${expectedContractVersion}`,
    );
    return {
      compatible: false,
      status: 'contract_mismatch',
      reasons,
      missingCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  if (
    requirement.minHostVersion &&
    compareSemver(manifest.host.version, requirement.minHostVersion) < 0
  ) {
    reasons.push(
      `host ${manifest.host.version} is older than required ${requirement.minHostVersion}`,
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

  const capabilityKinds = new Set(manifest.capabilities.map((capability) => capability.kind));
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

  const eventSchemas = new Set(manifest.eventSinks.flatMap((sink) => [...sink.schemas]));
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

  const providerFamilies = new Set(manifest.providers.flatMap((provider) => [...provider.families]));
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
