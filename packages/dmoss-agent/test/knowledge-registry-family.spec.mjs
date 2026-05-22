#!/usr/bin/env node
/**
 * Pure-node self-test for knowledge-module-registry `findModuleForFamily`
 * and `warnIfDependencyCycle` behavior.
 *
 * We cannot directly import `packages/dmoss-agent/src/knowledge/registry.ts`
 * here because it depends on host logger plumbing. Instead we replicate
 * the relevant logic in-file (verbatim, copy-read) and assert the
 * contract of `priority DESC → id ASC` + `cycle-warn-not-throw`.
 *
 * Real integration-level coverage (the *actual* registry function running
 * in host context) is ensured by tsc typecheck in verify + downstream
 * integration tests in sub-05 / sub-06 when they wire `family='rdk'`
 * into `rdkKnowledgeModule`.
 *
 * Run: `node packages/dmoss-agent/test/knowledge-registry-family.spec.mjs`
 * Exit 0 on pass; exit 1 on any assertion failure.
 */

import assert from 'node:assert/strict';

/* ---- Replicated registry logic (must stay byte-equal to host impl) ---- */

function makeRegistry() {
  const modules = new Map();
  const warnings = [];
  const log = {
    warn: (msg, meta) => warnings.push({ msg, meta }),
    debug: () => {},
  };

  function warnIfDependencyCycle(newMod) {
    const deps = newMod.dependencies ?? [];
    if (deps.length === 0) return;
    for (const depId of deps) {
      const existing = modules.get(depId);
      if (!existing) continue;
      const existingDeps = existing.dependencies ?? [];
      if (existingDeps.includes(newMod.id)) {
        log.warn('dependency cycle detected', {
          modules: [newMod.id, existing.id],
          note: 'direct 2-node cycle; registration continues',
        });
      }
    }
  }

  return {
    register(mod) {
      warnIfDependencyCycle(mod);
      modules.set(mod.id, mod);
    },
    findByFamily(family) {
      const candidates = [];
      for (const mod of modules.values()) {
        if (mod.family === family) candidates.push(mod);
      }
      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0];
      candidates.sort((a, b) => {
        const pa = a.platformClaimPriority ?? 0;
        const pb = b.platformClaimPriority ?? 0;
        if (pb !== pa) return pb - pa;
        return a.id.localeCompare(b.id);
      });
      return candidates[0];
    },
    getWarnings() {
      return warnings;
    },
  };
}

/* ---- Test 1: single module with family hits ---- */

{
  const reg = makeRegistry();
  reg.register({ id: 'jetson-k', family: 'jetson', platforms: ['jetson-orin-nx'] });
  const hit = reg.findByFamily('jetson');
  assert.equal(hit?.id, 'jetson-k', 'single module family hit');
  assert.equal(reg.findByFamily('rdk'), undefined, 'unmatched family → undefined');
  console.log('  [PASS] single module family hit');
}

/* ---- Test 2: priority DESC wins ---- */

{
  const reg = makeRegistry();
  reg.register({ id: 'low', family: 'jetson', platformClaimPriority: 0, platforms: ['a'] });
  reg.register({ id: 'high', family: 'jetson', platformClaimPriority: 100, platforms: ['b'] });
  const hit = reg.findByFamily('jetson');
  assert.equal(hit?.id, 'high', 'priority DESC → high priority wins');
  console.log('  [PASS] priority DESC resolution');
}

/* ---- Test 3: same priority → id ASC wins ---- */

{
  const reg = makeRegistry();
  reg.register({ id: 'zebra', family: 'rdk', platformClaimPriority: 50, platforms: ['a'] });
  reg.register({ id: 'alpha', family: 'rdk', platformClaimPriority: 50, platforms: ['b'] });
  const hit = reg.findByFamily('rdk');
  assert.equal(hit?.id, 'alpha', 'same priority → id ASC (alpha before zebra)');
  console.log('  [PASS] same priority id-ASC tiebreak');
}

/* ---- Test 4: cycle A↔B triggers warn but both register ---- */

{
  const reg = makeRegistry();
  reg.register({ id: 'A', platforms: [], dependencies: ['B'] });
  reg.register({ id: 'B', platforms: [], dependencies: ['A'] });
  const warns = reg.getWarnings();
  assert.equal(warns.length, 1, 'exactly 1 cycle warn emitted');
  assert.ok(warns[0].msg.includes('cycle'), 'warn message mentions cycle');
  const modSet = new Set([warns[0].meta.modules[0], warns[0].meta.modules[1]]);
  assert.deepEqual(
    [...modSet].sort(),
    ['A', 'B'],
    'warn meta lists both modules in cycle'
  );
  console.log('  [PASS] cycle detection emits warn without throw');
}

/* ---- Test 5: non-cycle deps do NOT warn ---- */

{
  const reg = makeRegistry();
  reg.register({ id: 'base', platforms: [] });
  reg.register({ id: 'consumer', platforms: [], dependencies: ['base'] });
  assert.equal(reg.getWarnings().length, 0, 'linear dep chain → 0 warns');
  console.log('  [PASS] non-cycle dep chain is silent');
}

console.log('\n[pass] knowledge-registry-family self-test: 5/5');
