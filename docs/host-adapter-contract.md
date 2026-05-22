# Moss Host Adapter Contract

Moss is intended to evolve as an independent open-source runtime. Product shells
such as RDK Studio should keep credentials, UI, native integrations, and
device-specific code outside of Moss, then expose them through a narrow host
adapter.

The public contract lives in `@dmoss/core/contracts/host-adapter`.

## Ownership

- Moss owns agent behavior, context management, memory logic, reusable skills,
  safety helpers, and public extension contracts.
- The host owns model keys, Supabase keys, product UI, device access, local file
  policy, external channels, and any proprietary service integrations.
- The adapter is the only place where those two sides meet.

## Upgrade Rule

A Moss release can be adopted by a host without changing host code when:

- `contractVersion` matches `MOSS_HOST_ADAPTER_CONTRACT_VERSION`.
- The host version satisfies the Moss release requirement.
- Required capability kinds are present in the host manifest.
- Required event schemas and provider families are present.

If one of those checks fails, the host adapter must be updated before the Moss
bundle is upgraded. This keeps the normal path simple while making incompatible
changes explicit.

## Minimal Host Manifest

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@dmoss/core/contracts/host-adapter';

const manifest: MossHostRuntimeManifest = {
  schema: 'moss_host_adapter.v1',
  contractVersion: MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  host: { id: 'example-host', name: 'Example Host', version: '1.2.0' },
  moss: {
    version: '0.3.1',
    packages: [{ name: '@dmoss/core', version: '0.3.1', stability: 'stable' }],
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

## Compatibility Promise

Changes to this file follow semver:

- Patch releases may add optional fields or new helper functions.
- Minor releases may add optional capability kinds.
- Major releases may change required fields or behavior.

Hosts should validate the manifest during CI and expose the report in product
diagnostics so a Moss upgrade cannot silently degrade the user experience.
