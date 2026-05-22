# Contributing to D-Moss

Thank you for your interest in contributing to D-Moss! This document provides guidelines for contributing to the `@dmoss/core` package.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/D-Moss/dmoss-core.git
cd dmoss-core

# Install dependencies
npm install

# Type-check
npm run typecheck

# Build
npm run build
```

## Project Structure

```
packages/dmoss/
├── src/
│   ├── index.ts                              # Public API (all exports)
│   ├── contracts/
│   │   ├── knowledge-module.ts               # KnowledgeModule + DeviceProfileBase + related
│   │   ├── vendor-plugin.ts                  # VendorPlugin + PromptContributor + ToolContributor
│   │   └── platform-extension.ts             # PlatformExtension (bundles knowledge + vendor)
│   └── prompts/
│       └── robotics-engineering-prompt.ts     # Vendor-agnostic robotics prompts
├── package.json
├── tsconfig.json            # Type-check only (noEmit)
├── tsconfig.build.json      # Build to dist/
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── INTEGRATION.md
```

## Guidelines

### Adding New Contracts

1. Place new contract interfaces in `src/contracts/`
2. Export them from `src/index.ts`
3. Keep contracts **vendor-neutral** — no hardware-specific names, URLs, or constants
4. Use TypeScript generics (e.g. `<THostTool>`) where host binding is needed
5. Add JSDoc comments explaining the purpose and usage

### Modifying Existing Contracts

- **Non-breaking changes** (adding optional fields): bump **minor** version
- **Breaking changes** (renaming, removing, changing required fields): bump **major** version
- Always update `CHANGELOG.md`

### Prompt Engineering

- Prompts in `src/prompts/` must be **vendor-agnostic**
- Reference capabilities by generic names (`device_exec`, `web_fetch`) not product-specific tools
- Write in Chinese with English technical terms (matching the robotics developer community)

### Code Style

- TypeScript strict mode (`strict: true`)
- ESM imports with `.js` extensions (for Node.js ESM compatibility)
- No runtime dependencies — this package is pure TypeScript types and string builders
- Use `export type` for type-only exports (`verbatimModuleSyntax: true`)

### Testing

```bash
npm run typecheck    # Type-check without emit
npm run build        # Full build to dist/
```

### Commit Messages

Follow conventional commits:

```
feat: add ToolRegistry contract
fix: correct PromptFragment tier type
docs: update KnowledgeModule JSDoc
```

## Dependency Rules

**CRITICAL**: `@dmoss/core` must have **zero** imports from:
- `server/` (host application)
- `src/` (frontend)
- `electron/` (desktop shell)
- Any npm runtime package

This ensures the package can be published and consumed standalone.

## Security and `npm audit` (monorepo)

From the repo root, run `npm audit` / `npm audit fix` when preparing changes. `@dmoss/core` has **zero runtime dependencies**; most audit noise comes from other parts of the monorepo. Prioritize findings that would affect the **published** `@dmoss/core` tarball. See `SECURITY.md`.

## Releasing

1. Update version in `package.json` (semver)
2. Update `CHANGELOG.md`
3. Run `npm run build` to verify
4. `npm publish` (uses `prepublishOnly` hook)

## Questions?

Open an issue on GitHub or reach out to the maintainers.
