# D-Moss

**Vendor-neutral robotics agent framework** — pluggable knowledge modules, platform extensions, and engineering prompts for building AI-powered robotics developer tools.

D-Moss provides the **contract layer** that allows any hardware platform (Jetson, Raspberry Pi, custom boards, etc.) to plug into an AI agent system with domain-specific knowledge, device profiles, and prompt engineering.

Together with `@dmoss/agent`, it forms the **contract side** of the open-source **Agent harness** (everything beyond a raw LLM call: pluggable knowledge, stable extension points, shared robotics prompts). See the runtime counterpart at [`packages/dmoss-agent/README.md`](../dmoss-agent/README.md) and the monorepo overview in the root [`README.md`](../../README.md).

## Features

- **KnowledgeModule** — plug in domain knowledge for any hardware: device profiles, documentation indexes, command semantics, failure recovery hints, and optional provenance metadata
- **PlatformExtension** — the primary integration point for new device ecosystems, bundling knowledge + vendor plugins + tool contributions
- **VendorPlugin** — extend the agent's prompt layers and tool capabilities per vendor
- **Robotics Engineering Prompts** — battle-tested, vendor-agnostic prompt fragments for robotics agent orchestration

## Installation

```bash
npm install @dmoss/core@latest
```

## Quick Start

### Implement a Knowledge Module

```typescript
import type { KnowledgeModule } from '@dmoss/core';

const myBoardKnowledge: KnowledgeModule = {
  id: 'my-board',
  name: 'My Robotics Board',
  version: '1.0.0',
  description: 'Domain knowledge for My Board',
  platforms: ['my-board-v1', 'my-board-v2'],

  getDeviceProfiles: () => ({
    'my-board-v1': {
      platform: 'my-board-v1',
      displayName: 'My Board V1',
      soc: 'Custom SoC',
      computeUnit: 'NPU',
      computeTops: 8,
      cpu: 'Quad-core Cortex-A72',
      ramGb: 4,
      modelFormat: 'ONNX',
      diagnosticCommand: 'npu-smi',
      runtimeBasePath: '/opt/my-sdk',
      systemPython: '/usr/bin/python3',
      inferLibPackage: 'my-infer-lib',
      detectionPatterns: ['my-board', 'My Board'],
      limitations: ['Max 8 TOPS'],
      docBaseUrl: 'https://docs.my-board.dev/',
      capabilityNotes: ['8 TOPS NPU, suitable for edge inference'],
    },
  }),

  getDocIndex: () => [],
  getPromptFragments: () => [],
  getCommandPatterns: () => [],
  getFailureHints: () => [],
  getEcosystemPrompt: () => '## My Board Ecosystem\n...',
};
```

### Create a Platform Extension

```typescript
import type { DmossPlatformExtension } from '@dmoss/core';

const myExtension: DmossPlatformExtension = {
  id: 'my-board-ext',
  displayName: 'My Board Extension',
  version: '1.0.0',
  knowledgeModuleId: 'my-board',
  vendorPluginId: 'my-board-vendor',

  isEnabled: () => process.env.MY_BOARD_ENABLED === 'true',
  getKnowledgeModule: () => myBoardKnowledge,
  getVendorPlugin: () => ({
    id: 'my-board-vendor',
    displayName: 'My Board',
    promptContributors: [{ id: 'my-prompts', buildStableLayers: () => ['...'] }],
  }),
};
```

### Use Robotics Engineering Prompts

```typescript
import { buildRoboticsEngineeringPrompt } from '@dmoss/core';

const systemPrompt = buildRoboticsEngineeringPrompt();
// Returns vendor-agnostic robotics engineering guidance
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    @dmoss/core (this package)                │
│                                                             │
│  ┌──────────────────┐  ┌─────────────────┐  ┌───────────┐  │
│  │ KnowledgeModule  │  │ PlatformExtension│  │ Robotics  │  │
│  │ DeviceProfileBase│  │ VendorPlugin     │  │ Prompts   │  │
│  │ PromptFragment   │  │ ToolContributor  │  │           │  │
│  │ CommandPattern   │  │ PromptContributor│  │           │  │
│  │ FailureHint      │  │                  │  │           │  │
│  └──────────────────┘  └─────────────────┘  └───────────┘  │
└──────────────────────────────┬──────────────────────────────┘
                               │ implements
           ┌───────────────────┼───────────────────┐
           │                   │                   │
    ┌──────▼──────┐    ┌───────▼──────┐    ┌───────▼──────┐
    │Your Module  │    │Jetson Module │    │ RPi Module   │
    │ (host app)  │    │ (community)  │    │ (community)  │
    └─────────────┘    └──────────────┘    └──────────────┘
```

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@dmoss/core` | Core contracts and prompts (this package) | Open Source (MIT) |

## Implementing a Knowledge Module

To add support for a new hardware platform:

1. Define device profiles for your hardware family
2. Implement `KnowledgeModule` with prompt fragments, command patterns, and failure hints
3. Bundle hardware-specific Markdown knowledge

## API Reference

### Contracts

| Interface | Description |
|-----------|-------------|
| `KnowledgeModule` | Pluggable domain knowledge for a hardware platform |
| `DeviceProfileBase` | Hardware capability description (SoC, compute, RAM, etc.) |
| `DmossPlatformExtension<T>` | Full extension point: knowledge + vendor + tools |
| `DmossVendorPlugin<T>` | Prompt and tool contributions per vendor |
| `DmossPromptContributor` | Stable/dynamic prompt layer contributions |
| `DmossToolContributor<T>` | Device-specific tool factory |
| `PromptFragment` | Typed prompt fragment with priority and filtering |
| `CommandPattern` | Command semantics for risk analysis |
| `FailureHint` | Error pattern to recovery suggestion mapping |

Knowledge records can carry optional `metadata` with source, compatibility
scope, status, confidence, citation label, and chunking hints. Consumers that do
not need trusted-package governance can ignore the field; hosts that do can
preserve it across search, prompt assembly, citations, and audits.

### Functions

| Function | Description |
|----------|-------------|
| `buildRoboticsEngineeringPrompt()` | Full robotics engineering system prompt |
| `buildRoboticsEngineeringPromptQuick()` | Compact version for smaller context windows |

## Design Principles

1. **Zero host dependency** — this package has no runtime dependencies and does not import from any host application code
2. **Generic types** — `DmossVendorPlugin<THostTool>` and `DmossPlatformExtension<THostTool>` allow any host to bind its own tool type
3. **Vendor neutral** — no hardware vendor names, URLs, or product-specific content in the core package
4. **Contract-first** — define interfaces, let implementations live in separate packages

**API stability:** Anything exported from `src/index.ts` and the `package.json` `exports` map is treated as **stable** within a major version. Do not import deep paths that are not listed in `exports`. For the agent runtime, see [`@dmoss/agent` API stability](../dmoss-agent/API.md#api-stability-labels).

## Known Limitations

- **Robotics scope assumption**: `buildRoboticsEngineeringPrompt()` provides robotics-domain guidance. For non-robotics use cases (IoT sensors, edge AI inference, etc.), hosts should build their own domain prompt instead of using this function. A future version may move this to an optional `@dmoss/prompts-robotics` package.
- **Publishing**: This package is prepared for public npm release as part of the Moss publish set. Before a release, run `npm run verify` from the repo root; it covers OSS boundary checks, workspace hygiene, workspace builds, typechecks, and package tests. Use the release checklist for host consumption validation.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

[MIT](./LICENSE)
