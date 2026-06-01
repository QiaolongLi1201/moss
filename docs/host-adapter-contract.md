# Moss Host Adapter Contract

Moss is intended to evolve as an independent open-source runtime. Product shells
should keep credentials, UI, native integrations, and
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
    version: '0.3.2',
    packages: [{ name: '@rdk-moss/core', version: '0.3.2', stability: 'stable' }],
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

### Tool Surfaces (10)

Host Adapter v1 now has an optional `tools[].surface` field so Moss can evaluate
user-visible capability coverage inspired by OpenClaw's tool layer without
copying OpenClaw's product shape. This is backward compatible: older manifests
without `surface` still validate, while newer Moss requirements can ask for
specific surfaces through `requiredToolSurfaces`. When a host does provide
`surface`, the value must be one of the known strings below; unknown strings make
the manifest invalid so a misspelled capability does not degrade into a vague
missing-capability report.

```
computer_workspace, computer_shell, browser_web, attachment_media,
board_device, robotics_runtime, channel_messaging, task_subagent,
memory_skill, openclaw_channel
```

`openclaw_channel` is reserved for actual channel/backplane tools such as
gateway status, health checks, delegation, pairing, skills, logs, and fleet
dispatch. A local TUI shell command remains `computer_shell`; it is not an
OpenClaw gateway just because the workflow was inspired by OpenClaw.

### Result Surfaces (7)

The optional `tools[].resultSurface` field describes how the host presents tool
progress/results to users. When present, it must be one of the known strings
below.

```
assistant_text, timeline_summary, terminal_output, artifact, media_or_file,
channel_delivery, background_task
```

### Runtime Projection And Effective Inventory

`projectMossHostRuntimeCapabilities(manifest)` returns the capability sets that
Moss actually reads from the manifest: capability kinds, tool surfaces, surface
details, task lifecycle capabilities, channel/backplane capabilities, event
schemas, and provider families. `evaluateMossHostCompatibility()` uses this
projection, so a declaration is not merely documentation.

`buildMossHostEffectiveToolInventory(manifest, context)` builds the session-level
"available right now" view. It starts from the declared manifest, then applies
runtime inputs such as:

```ts
{
  readySignals: ['device_selected', 'device_reachable'],
  disabledTools: ['read_attachment'],
  policyDeniedTools: ['board_openclaw_delegate'],
  profileHiddenTools: ['web_fetch'],
}
```

The result keeps each declared tool visible and annotates unavailable tools with
structured notices such as `tool_denied_by_policy`, `tool_hidden_by_profile`,
`tool_disabled_by_runtime`, or `surface_readiness_missing`. Product UIs should
render these notices in diagnostics instead of hiding configured tools silently.

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

### Downstream Host Manifest

Downstream hosts should publish a concrete manifest generator that declares the
capability kinds, tool references, and permission boundaries they actually
provide. That manifest is the compatibility diagnostics surface evaluated with
`evaluateMossHostCompatibility()`; it can remain separate from the host's normal
chat runtime usage of Moss APIs.

### Runtime Integration

Downstream host runtime apps can directly import and use Moss runtime APIs such
as:
- `PiAiLLMProvider` — model provider adapter
- `JsonlSessionStore` — JSONL session persistence
- `MemoryManager` + `selectMemoriesForContext` — memory management
- `AgentMesh` — multi-agent collaboration
- `maybePersistConversationSkill` and host teaching hooks — skill learning

The `_executeChat` method implements the full chat lifecycle: setup → context
assembly → LLM execution → finalization. The runtime manifest is therefore a
diagnostics and upgrade-compatibility artifact, while DMossApp's normal
execution path consumes the Moss APIs directly.

### Known Gaps

1. Keep direct Moss API usage and the generated runtime manifest
   documented as separate integration surfaces.
2. When a host adds or removes direct Moss capabilities, update both the
   integration notes and the manifest generator consumed by runtime
   diagnostics.
3. Knowledge module version accuracy still needs a smoke check: generated host
   manifests should report the current knowledge module
   identity/version semantics rather than stale package metadata.
