# D-Moss Core — Integration Guide

## Architecture Overview

```
@dmoss/core               ← Zero dependencies, publishable standalone
       ↑ implements contracts
Host Application
  ├── server/dmoss-extensions/    ← PlatformExtension host bindings
  ├── server/knowledge-modules/   ← KnowledgeModule registry
  └── server/agent/plugins/       ← VendorPlugin host bindings (Tool type)

Knowledge Packages (parallel, not nested)
  ├── @your-org/your-knowledge     ← Your hardware knowledge module
  ├── @vendor/jetson-knowledge    ← Community implementation (example)
  └── ...
```

## Dependency Direction (must be followed)

1. **@dmoss/core** → has NO imports from `server/`, `src/`, `electron/`, or any host code
2. **Host** → imports contracts from `@dmoss/core`; implements `DmossPlatformExtension`, registers `KnowledgeModule`
3. **Knowledge packages** → import types from `@dmoss/core`; do NOT import from `server/` or other host code
4. **Knowledge packages** → do NOT import from each other

## How the Host Consumes @dmoss/core

### 1. Bind Generic Types to Host Tool

```typescript
// server/agent/plugins/dmoss-plugin-types.ts
import type { Tool } from '../tools/types.js';
import type { DmossVendorPlugin } from '@dmoss/core';

export type DMossVendorPlugin = DmossVendorPlugin<Tool>;
```

### 2. Implement Platform Extensions

```typescript
// server/dmoss-extensions/builtins/my-platform-extension.ts
import type { DmossPlatformExtension } from '@dmoss/core';
import type { Tool } from '../../agent/tools/types.js';

export function createMyPlatformExtension(): DmossPlatformExtension<Tool> {
  return {
    id: 'my-platform',
    displayName: 'My Platform',
    version: '1.0.0',
    knowledgeModuleId: 'my-platform',
    vendorPluginId: 'my-vendor',
    isEnabled: () => true,
    getKnowledgeModule: () => myKnowledgeModule,
    getVendorPlugin: () => myVendorPlugin,
  };
}
```

### 3. Register in Bootstrap

```typescript
// server/dmoss-extensions/bootstrap.ts
import { createMyPlatformExtension } from './builtins/my-platform-extension.js';

const BUILTIN_EXTENSION_FACTORIES = [
  createMyPlatformExtension,
  // ...other extensions
];
```

## Splitting to a Separate Repository

When publishing `@dmoss/core` as a standalone npm package:

- [ ] Copy `packages/dmoss/` to a new repository
- [ ] Verify `npm run build` produces valid `dist/` output
- [ ] Update host imports from relative paths to `import '@dmoss/core'`
- [ ] Confirm no circular dependencies: `@dmoss/core` depends on nothing
- [ ] Publish to npm with `npm publish`
