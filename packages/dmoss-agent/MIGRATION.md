# Migration Guide: 0.x → 1.0

This guide covers the migration from deprecated global free functions to instance-scoped APIs.
All deprecated functions are scheduled for removal in version 1.0.

## Why migrate?

The deprecated functions delegate to a **process-scoped singleton**, which means:

- Multiple `DmossAgent` instances in the same process share state — registrations from one agent leak into another.
- Extension knowledge bindings are **not isolated** — the last agent to call `setKnowledgeRegistry()` overwrites the previous one's binding for all agents.
- A one-time `log.warn` is emitted on first call to each deprecated function.

Instance-scoped APIs give each `DmossAgent` its own `KnowledgeRegistry` and `PlatformExtensionRegistry`, providing true isolation.

As of the current unreleased version, `agent.extensions.*` is backed by a private
`PlatformExtensionRegistry` per `DmossAgent`. Deprecated extension free functions
still operate on a process-scoped legacy singleton; use them only as a migration
bridge for startup wiring, not as the live registry for existing agents.

## Quick reference

| Deprecated function | Replacement |
|---|---|
| `registerKnowledgeModule(mod)` | `agent.registerKnowledge(mod)` |
| `unregisterKnowledgeModule(id)` | `agent.knowledge.unregister(id)` |
| `getKnowledgeModule(id)` | `agent.knowledge.get(id)` |
| `getAllKnowledgeModules()` | `agent.knowledge.getAll()` |
| `findModuleForPlatform(platform)` | `agent.knowledge.findForPlatform(platform)` |
| `findModuleForFamily(family)` | `agent.knowledge.findForFamily(family)` |
| `getAllDeviceProfiles()` | `agent.knowledge.getAllDeviceProfiles()` |
| `getAllDocEntries()` | `agent.knowledge.getAllDocEntries()` |
| `getAllPromptFragments(filter?)` | `agent.knowledge.getAllPromptFragments(filter?)` |
| `getAllCommandPatterns()` | `agent.knowledge.getAllCommandPatterns()` |
| `getAllFailureHints()` | `agent.knowledge.getAllFailureHints()` |
| `getAggregatedEcosystemPrompt()` | `agent.knowledge.getAggregatedEcosystemPrompt()` |
| `setVendorPluginCallbacks(cb)` | `agent.extensions.setVendorPluginCallbacks(cb)` |
| `setKnowledgeRegistryForExtensions(reg)` | `agent.extensions.setKnowledgeRegistry(reg)` |
| `applyPlatformExtension(ext)` | `agent.extensions.apply(ext)` |
| `applyPlatformExtensionForce(ext)` | `agent.extensions.applyForce(ext)` |
| `syncPlatformExtensionsAtStartup(factories)` | `agent.extensions.syncAtStartup(factories)` |
| `getRegisteredPlatformExtensions()` | `agent.extensions.getExtensions()` |
| `setRegisteredPlatformExtensionsSnapshot(exts)` | `agent.extensions.setExtensionsSnapshot(exts)` |
| `resetPlatformExtensionRegistryForTests()` | `agent.extensions.reset()` |
| `listAppliedPlatformExtensionState()` | `agent.extensions.listAppliedState()` |

---

## Knowledge Module Functions

### registerKnowledgeModule → agent.registerKnowledge

**Before:**
```typescript
import { registerKnowledgeModule } from '@dmoss/agent';
registerKnowledgeModule(myModule);
```

**After:**
```typescript
agent.registerKnowledge(myModule);
```

**Behavioral difference:** The deprecated function registers to a process-scoped singleton and also pushes to a pending queue that is drained into new `DmossAgent` instances at construction time. The instance method registers directly to the agent's own `KnowledgeRegistry` — no bridging, no cross-agent leakage.

### unregisterKnowledgeModule → agent.knowledge.unregister

**Before:**
```typescript
import { unregisterKnowledgeModule } from '@dmoss/agent';
unregisterKnowledgeModule('my-module-id');
```

**After:**
```typescript
agent.knowledge.unregister('my-module-id');
```

### getKnowledgeModule → agent.knowledge.get

**Before:**
```typescript
import { getKnowledgeModule } from '@dmoss/agent';
const mod = getKnowledgeModule('my-module-id');
```

**After:**
```typescript
const mod = agent.knowledge.get('my-module-id');
```

### getAllKnowledgeModules → agent.knowledge.getAll

**Before:**
```typescript
import { getAllKnowledgeModules } from '@dmoss/agent';
const modules = getAllKnowledgeModules();
```

**After:**
```typescript
const modules = agent.knowledge.getAll();
```

### findModuleForPlatform → agent.knowledge.findForPlatform

**Before:**
```typescript
import { findModuleForPlatform } from '@dmoss/agent';
const mod = findModuleForPlatform('rdk-x3');
```

**After:**
```typescript
const mod = agent.knowledge.findForPlatform('rdk-x3');
```

### findModuleForFamily → agent.knowledge.findForFamily

**Before:**
```typescript
import { findModuleForFamily } from '@dmoss/agent';
const mod = findModuleForFamily('rdk-x3');
```

**After:**
```typescript
const mod = agent.knowledge.findForFamily('rdk-x3');
```

### getAllDeviceProfiles → agent.knowledge.getAllDeviceProfiles

**Before:**
```typescript
import { getAllDeviceProfiles } from '@dmoss/agent';
const profiles = getAllDeviceProfiles();
```

**After:**
```typescript
const profiles = agent.knowledge.getAllDeviceProfiles();
```

### getAllDocEntries → agent.knowledge.getAllDocEntries

**Before:**
```typescript
import { getAllDocEntries } from '@dmoss/agent';
const entries = getAllDocEntries();
```

**After:**
```typescript
const entries = agent.knowledge.getAllDocEntries();
```

### getAllPromptFragments → agent.knowledge.getAllPromptFragments

**Before:**
```typescript
import { getAllPromptFragments } from '@dmoss/agent';
const fragments = getAllPromptFragments({ tier: 'base', mode: 'interactive' });
```

**After:**
```typescript
const fragments = agent.knowledge.getAllPromptFragments({ tier: 'base', mode: 'interactive' });
```

### getAllCommandPatterns → agent.knowledge.getAllCommandPatterns

**Before:**
```typescript
import { getAllCommandPatterns } from '@dmoss/agent';
const patterns = getAllCommandPatterns();
```

**After:**
```typescript
const patterns = agent.knowledge.getAllCommandPatterns();
```

### getAllFailureHints → agent.knowledge.getAllFailureHints

**Before:**
```typescript
import { getAllFailureHints } from '@dmoss/agent';
const hints = getAllFailureHints();
```

**After:**
```typescript
const hints = agent.knowledge.getAllFailureHints();
```

### getAggregatedEcosystemPrompt → agent.knowledge.getAggregatedEcosystemPrompt

**Before:**
```typescript
import { getAggregatedEcosystemPrompt } from '@dmoss/agent';
const prompt = getAggregatedEcosystemPrompt();
```

**After:**
```typescript
const prompt = agent.knowledge.getAggregatedEcosystemPrompt();
```

---

## Extension Functions

### setVendorPluginCallbacks → agent.extensions.setVendorPluginCallbacks

**Before:**
```typescript
import { setVendorPluginCallbacks } from '@dmoss/agent';
setVendorPluginCallbacks({
  register: (plugin) => { /* ... */ },
  unregister: (id) => { /* ... */ },
});
```

**After:**
```typescript
agent.extensions.setVendorPluginCallbacks({
  register: (plugin) => { /* ... */ },
  unregister: (id) => { /* ... */ },
});
```

**Behavioral difference:** The deprecated function sets callbacks on a shared singleton — all agents in the process use the same callbacks. The instance method scopes callbacks to one agent's extension registry.

### setKnowledgeRegistryForExtensions → agent.extensions.setKnowledgeRegistry

**Before:**
```typescript
import { setKnowledgeRegistryForExtensions } from '@dmoss/agent';
setKnowledgeRegistryForExtensions(myRegistry);
```

**After:**
```typescript
agent.extensions.setKnowledgeRegistry(myRegistry);
```

**Behavioral difference:** The deprecated function overwrites the knowledge binding for **all** agents sharing the singleton. The last agent to call it wins. The instance method binds only the calling agent's extension registry to its own knowledge registry.

### applyPlatformExtension → agent.extensions.apply

**Before:**
```typescript
import { applyPlatformExtension } from '@dmoss/agent';
applyPlatformExtension(myExtension);
```

**After:**
```typescript
agent.extensions.apply(myExtension);
```

### applyPlatformExtensionForce → agent.extensions.applyForce

**Before:**
```typescript
import { applyPlatformExtensionForce } from '@dmoss/agent';
applyPlatformExtensionForce(myExtension);
```

**After:**
```typescript
agent.extensions.applyForce(myExtension);
```

### syncPlatformExtensionsAtStartup → agent.extensions.syncAtStartup

**Before:**
```typescript
import { syncPlatformExtensionsAtStartup } from '@dmoss/agent';
syncPlatformExtensionsAtStartup([extFactoryA, extFactoryB]);
```

**After:**
```typescript
agent.extensions.syncAtStartup([extFactoryA, extFactoryB]);
```

### getRegisteredPlatformExtensions → agent.extensions.getExtensions

**Before:**
```typescript
import { getRegisteredPlatformExtensions } from '@dmoss/agent';
const exts = getRegisteredPlatformExtensions();
```

**After:**
```typescript
const exts = agent.extensions.getExtensions();
```

### setRegisteredPlatformExtensionsSnapshot → agent.extensions.setExtensionsSnapshot

**Before:**
```typescript
import { setRegisteredPlatformExtensionsSnapshot } from '@dmoss/agent';
setRegisteredPlatformExtensionsSnapshot(extensions);
```

**After:**
```typescript
agent.extensions.setExtensionsSnapshot(extensions);
```

### resetPlatformExtensionRegistryForTests → agent.extensions.reset

**Before:**
```typescript
import { resetPlatformExtensionRegistryForTests } from '@dmoss/agent';
resetPlatformExtensionRegistryForTests();
```

**After:**
```typescript
agent.extensions.reset();
```

### listAppliedPlatformExtensionState → agent.extensions.listAppliedState

**Before:**
```typescript
import { listAppliedPlatformExtensionState } from '@dmoss/agent';
const state = listAppliedPlatformExtensionState();
```

**After:**
```typescript
const state = agent.extensions.listAppliedState();
```
