# Contributing to `@dmoss/agent`

Thank you for contributing to `@dmoss/agent`.

This package is the standalone D-Moss runtime. It should remain vendor-neutral, host-agnostic, and safe to publish independently from any embedding host product.

## Scope

`@dmoss/agent` owns the reusable runtime pieces:

- `DmossAgent`
- `LLMProvider` abstractions
- `SessionStore` implementations
- `ToolRegistry` and tool execution lifecycle
- context pruning / compaction
- safety helpers
- skill registry
- platform extension lifecycle

The following are **not** part of this package:

- host-application HTTP routes and product-specific orchestration
- frontend / UI behavior
- desktop shell integration
- host-specific product SDKs and internal contracts

## Development Setup

From the monorepo root:

```bash
npm install
npm run typecheck --workspace=@dmoss/agent
npm run build --workspace=@dmoss/agent
npx vitest run \
  packages/dmoss-agent/src/__tests__/exports.test.ts \
  packages/dmoss-agent/src/core/__tests__/dmoss-agent.test.ts
```

## Dependency and security checks (monorepo)

From the repository root, periodically:

```bash
npm audit
npm audit fix
```

- **Priority**: advisories that affect **`@dmoss/agent` runtime `dependencies`** (`@dmoss/core`, `@mariozechner/pi-ai`, and any future runtime deps).
- **Lower priority**: devDependencies and transitive packages only used by the desktop shell, icons, or optional integrations — track them, but do not block OSS package releases unless they affect the published tarball.
- If `npm audit fix` requires `--force`, discuss in a PR before upgrading (may be semver-breaking).

See also `SECURITY.md` and the root `CODE_OF_CONDUCT.md`.

## Project Structure

```text
packages/dmoss-agent/
├── src/
│   ├── core/          # DmossAgent, sessions, tools, hooks, event types
│   ├── context/       # pruning, compaction, truncation, token helpers
│   ├── provider/      # provider adapters and retry/error helpers
│   ├── safety/        # secrets, command safety, sandbox paths
│   ├── skills/        # SKILL.md scanning and matching
│   ├── knowledge/     # knowledge registry
│   ├── extensions/    # platform extension registry/lifecycle
│   ├── utils/         # tracing, smoothing, env helpers
│   └── tools/         # built-in minimal tools
├── README.md
├── API.md
├── USAGE.md
├── CHANGELOG.md
├── SECURITY.md
└── package.json
```

## Public API Rules

This package has a documented public surface in [`API.md`](./API.md).

When changing exports:

1. Update `src/index.ts` or the relevant subpath barrel.
2. Update `package.json` exports if a new stable subpath is introduced.
3. Update [`API.md`](./API.md) and [`README.md`](./README.md) when the change affects consumers.
4. Update export snapshot tests.

### Semver Expectations

- Adding a new optional config field: **minor**
- Adding a new export without breaking existing behavior: **minor**
- Renaming or removing an export: **major**
- Changing runtime behavior in a surprising way: evaluate carefully and document in `CHANGELOG.md`

## Dependency Rules

`@dmoss/agent` may depend on:

- `@dmoss/core`
- `@mariozechner/pi-ai` (bundled so **`PiAiLLMProvider`** is always resolvable from npm — **hosts are not required to use it**; the supported minimal integration is a custom **`LLMProvider`**, see package `README.md` / `API.md` and repo `examples/minimal*`)
- Node.js built-ins

It must **not** import from:

- `server/`
- `src/`
- `electron/`
- product-specific storage or network code owned by the host app

## Design Guidelines

- Keep the package vendor-neutral and host-neutral
- Prefer extension points over product-specific conditionals
- Treat device and product details as host concerns unless the abstraction is broadly reusable
- Keep runtime-facing docs and JSDoc in English
- Prefer narrow, typed exports over undocumented internal leakage

## Testing Expectations

Every meaningful runtime change should include one of:

- a focused unit test in `src/**/__tests__/`
- an export snapshot update when the public surface changes
- a regression test for a previously observed failure mode

Before opening a PR, run:

```bash
npm run typecheck --workspace=@dmoss/agent
npm run build --workspace=@dmoss/agent
npx vitest run packages/dmoss-agent/src/__tests__/exports.test.ts
```

If your change touches runtime behavior, run the relevant package tests under `packages/dmoss-agent/src/**/__tests__/`.

## Documentation Expectations

Please update documentation whenever you change:

- public exports
- configuration fields
- event semantics
- hook behavior
- CLI behavior

Minimum docs to check:

- [`README.md`](./README.md)
- [`API.md`](./API.md)
- [`USAGE.md`](./USAGE.md)
- [`CHANGELOG.md`](./CHANGELOG.md)

## Commit Style

Use conventional commit style when possible:

```text
feat(agent): add context guard helper
fix(agent): avoid duplicate tool replay
docs(agent): clarify event layers
test(agent): add follow-up guard regression
```

## Release Checklist

Before publishing a new version:

1. Update `package.json` version
2. Update `CHANGELOG.md`
3. Run package typecheck, build, and tests
4. Confirm `API.md` matches the actual export surface
5. Publish only after `@dmoss/core` is already available at the required version

## Contribution Map

External contributors should be able to work on D-Moss without understanding RDK Studio internals. Use this map to place changes:

| Contribution | Primary files | Notes |
| --- | --- | --- |
| New `KnowledgeModule` | Separate package or `packages/<platform>-knowledge/`; contracts from `@dmoss/core/contracts/knowledge-module` | Keep hardware facts, docs, prompts, command patterns, and failure hints in the knowledge package. Register through `@dmoss/agent/knowledge`. |
| New `Tool` | Host package for product-specific tools; `packages/dmoss-agent/src/tools/` only for generic built-ins | Tool definitions use the `Tool` contract from `@dmoss/agent/core`. Put device credentials, UI assumptions, and product routes in the host. |
| New `LLMProvider` | `packages/dmoss-agent/src/provider/` for generic adapters; host package for product-specific transports | `DmossAgent` depends only on the `LLMProvider` interface. Avoid SDK-specific behavior in core loop code. |
| New CLI capability | `packages/dmoss-agent/src/cli.ts` plus README/API updates | CLI features must work in a fresh Node project and must not require RDK Studio files or env vars. |
| New platform extension | `packages/dmoss-agent/src/extensions/` for lifecycle helpers; contracts from `@dmoss/core/contracts/platform-extension` | Platform extensions should compose knowledge and optional vendor hooks without importing host code. |
| New safety policy | `packages/dmoss-agent/src/safety/` or host `AgentHooks.onBeforeToolExec` | Generic command/path/secret helpers belong in the package; product approval UX and account state belong in the host. |

## Adding a New Hardware Platform

Want to add support for a new device family (Jetson, Raspberry Pi, RISC-V, etc.)? Follow these 5 steps:

### Step 1: Create a KnowledgeModule

Implement the `KnowledgeModule` interface from `@dmoss/core`:

```typescript
import type { KnowledgeModule } from '@dmoss/core/contracts/knowledge-module';

export const myPlatformModule: KnowledgeModule = {
  id: 'my-platform',
  name: 'My Platform Knowledge',
  version: '0.1.0',
  description: 'Domain knowledge for My Platform',
  platforms: ['my-board-v1', 'my-board-v2'],
  getDeviceProfiles: () => ({ /* ... */ }),
  getDocIndex: () => [/* ... */],
  getPromptFragments: () => [/* ... */],
  getCommandPatterns: () => [/* ... */],
  getFailureHints: () => [/* ... */],
  getEcosystemPrompt: () => '...',
};
```

### Step 2: Fill in DeviceProfileBase

Each board variant needs a complete `DeviceProfileBase` with hardware specs (SoC, compute, RAM, cameras, GPIO, etc.). The agent uses these to tailor commands and diagnose issues.

### Step 3: Add Domain Knowledge

- **DocIndex**: URLs to official docs for search and prompt injection
- **PromptFragments**: Platform-specific guidance (e.g., "use `tegrastats`", "convert to TensorRT")
- **CommandPatterns**: Categorize commands by risk level (`safe`/`moderate`/`dangerous`)
- **FailureHints**: Map common error patterns to recovery suggestions

### Step 4: Register at Startup

```typescript
import { registerKnowledgeModule } from '@dmoss/agent/knowledge';
registerKnowledgeModule(myPlatformModule);
```

### Step 5: Test and Submit

```bash
npx vitest run  # ensure no regressions
```

See [`examples/jetson-knowledge/`](../../examples/jetson-knowledge/) for a complete skeleton you can fork.

**Tip**: You don't need the actual hardware to write a KnowledgeModule. Start with public specs and docs, then refine with community feedback.

## Security

If your contribution affects tool execution, sandboxing, secrets, or prompt injection boundaries, review [`SECURITY.md`](./SECURITY.md) before merging.
