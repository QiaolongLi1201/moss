# Moss Host Adapter Contract

Moss is intended to evolve as an independent open-source runtime. Product shells
such as RDK Studio should keep credentials, UI, native integrations, and
device-specific code outside of Moss, then expose them through a narrow host
adapter.

The public contract lives in `@rdk-moss/core/contracts/host-adapter`.

## Ownership

- Moss owns agent behavior, context management, memory logic, reusable skills,
  safety helpers, and public extension contracts.
- The host owns model keys, Supabase keys, product UI, device access, local file
  policy, external channels, and any proprietary service integrations.
- The adapter is the only place where those two sides meet.

## Upgrade Rule

A Moss release can be adopted by a host without changing host code when:

- `contractVersion` matches `MOSS_HOST_ADAPTER_CONTRACT_VERSION`.
- Or, when Moss only needs a compatible range, the host contract version falls
  within `minContractVersion` and `maxContractVersion`.
- The host version satisfies the Moss release requirement.
- Required capability kinds are present in the host manifest.
- Required event schemas and provider families are present.

If one of those checks fails, the host adapter must be updated before the Moss
bundle is upgraded. This keeps the normal path simple while making incompatible
changes explicit.

Exact `contractVersion` still wins if it is present in the requirement. Range
fields are only used when Moss intentionally allows more than one host contract
version.

## Minimal Host Manifest

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';

const manifest: MossHostRuntimeManifest = {
  schema: 'moss_host_adapter.v1',
  contractVersion: MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  host: { id: 'example-host', name: 'Example Host', version: '1.2.0' },
  moss: {
    version: '0.3.1',
    packages: [{ name: '@rdk-moss/core', version: '0.3.1', stability: 'stable' }],
  },
  capabilities: [
    {
      kind: 'llm_provider',
      version: '1.0.0',
      stability: 'stable',
      summary: 'Host-configured model providers and credentials.',
    },
  ],
  providers: [],
  tools: [],
  eventSinks: [],
  knowledgeModules: [],
};

const report = evaluateMossHostCompatibility(manifest, {
  requiredCapabilities: ['llm_provider'],
});
```

## Manifest Validation

`evaluateMossHostCompatibility()` now rejects obviously invalid manifests with
`status: 'invalid_manifest'` before it performs compatibility checks. That
includes missing top-level sections such as `capabilities`, `providers`,
`tools`, `eventSinks`, or `knowledgeModules`, plus malformed records in the
sections that the compatibility check actually reads.

This is intentionally lightweight. It catches malformed input early without
turning the adapter into a full schema validator.

## Compatibility Promise

Changes to this file follow semver:

- Patch releases may add optional fields or new helper functions.
- Minor releases may add optional capability kinds.
- Major releases may change required fields or behavior.

Hosts should validate the manifest during CI and expose the report in product
diagnostics so a Moss upgrade cannot silently degrade the user experience.

## Code Reality (2026-05-24 Audit)

The contract is implemented in `packages/dmoss/src/contracts/host-adapter.ts`.
Key code-level facts from this audit snapshot:

### Capability Kinds (13)

```
llm_provider, tool_registry, approval_gate, event_sink, workspace,
memory, knowledge, prompt_context, skill_runtime, artifact_runtime,
device_runtime, channel_runtime, telemetry
```

### Compatibility Statuses (7)

```
ok, invalid_manifest, host_version_incompatible, contract_mismatch,
missing_capability, missing_event_schema, missing_provider_family
```

### Approval Levels (3)

```
not_required, plan_audit, execute_audit
```

### Side-Effect Classes (8)

```
readonly, local_write, device_mutation, credential, external_message,
memory_write, runtime_state, subagent
```

### Semver Handling

`evaluateMossHostCompatibility()` includes built-in semver parsing and
comparison for `minHostVersion` checks — no external dependency. It accepts
`MAJOR.MINOR.PATCH` with optional `-prerelease` or `+build` suffixes; suffixes
are tolerated in the input string but ignored during numeric comparison. That
means `1.2.3-rc.1`, `1.2.3+build.4`, and `1.2.3` compare as equal; the adapter
does not implement full prerelease ordering. Invalid version strings fall back
to `localeCompare()`.

Contract versions are numeric, not semver. They use exact `contractVersion`
matching when specified, otherwise `minContractVersion` / `maxContractVersion`
range checks.

### RDK Studio Manifest

The RDK Studio audit identifies a concrete manifest generator in
`rdstudio-web/server/dmoss/studio-host-adapter-contract.ts` that requires
12 of 13 capability kinds (all except `telemetry`, which is optional).
Tool references are derived from `listDeclaredToolCapabilityPolicies()` and
`classifyToolPermissionBoundary()`. That manifest is the compatibility
diagnostics surface evaluated with `evaluateMossHostCompatibility()`; it is
not the same path as the chat runtime's direct Moss API usage.

### DMossApp Integration

`rdstudio-web/server/dmoss/app.ts` is the chat/runtime bridge between RDK
Studio and Moss. DMossApp directly imports and uses Moss runtime APIs such as:
- `PiAiLLMProvider` — model provider adapter
- `JsonlSessionStore` — JSONL session persistence
- `MemoryManager` + `selectMemoriesForContext` — memory management
- `AgentMesh` — multi-agent collaboration
- `maybePersistConversationSkill` + `createStudioTeachingHooks` — skill learning

The `_executeChat` method implements the full chat lifecycle: setup → context
assembly → LLM execution → finalization. The runtime manifest is therefore a
diagnostics and upgrade-compatibility artifact, while DMossApp's normal
execution path consumes the Moss APIs directly.

### Known Gaps

1. Keep DMossApp's direct Moss API usage and the generated runtime manifest
   documented as separate integration surfaces.
2. When Studio adds or removes direct Moss capabilities, update both the
   DMossApp integration notes and the manifest generator consumed by runtime
   diagnostics.
3. Knowledge module version accuracy still needs a smoke check: Studio's
   generated manifest should report the current device-knowledge module
   identity/version semantics rather than stale package metadata.
