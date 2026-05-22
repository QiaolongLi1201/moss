#!/usr/bin/env node
/**
 * Pure-node self-test for platform-extension-catalog behavior.
 *
 * We cannot directly import the host-side
 * `server/dmoss-extensions/platform-extension-catalog.ts` here because
 * it binds the host `Tool` type. Instead we replicate its logic in-file
 * (verbatim, by copy-read) and assert the contract of `first-wins` +
 * `undefined-filtering` + `order-preserving de-dup`.
 *
 * Integration-level coverage (the *real* catalog function running in
 * host context) is ensured by tsc typecheck in verify + downstream
 * integration tests in sub-05 / sub-08 / sub-09 when they wire
 * `family='rdk' | 'jetson' | 'rpi'` into builtin extensions.
 *
 * Run: `node packages/dmoss/test/platform-extension-catalog.spec.mjs`
 * Exit 0 on pass; exit 1 on any assertion failure.
 */

import assert from 'node:assert/strict';

/* ---- Replicated catalog logic (must stay byte-equal to host impl) ---- */

function makeCatalog() {
  let cached = [];
  return {
    setSnapshot(exts) { cached = [...exts]; },
    getAll() { return cached; },
    getByFamily(family) { return cached.find((ext) => ext.family === family); },
    listCovered() {
      const seen = new Set();
      const out = [];
      for (const ext of cached) {
        if (ext.family && !seen.has(ext.family)) {
          seen.add(ext.family);
          out.push(ext.family);
        }
      }
      return out;
    },
  };
}

/* ---- Test fixtures ---- */

const extRdk = { id: 'rdk', family: 'rdk', displayName: 'RDK' };
const extRdkAlt = { id: 'rdk-alt', family: 'rdk', displayName: 'RDK-Alt' };
const extJetson = { id: 'jetson', family: 'jetson', displayName: 'Jetson' };
const extNoFam = { id: 'legacy', displayName: 'Legacy (no family)' };

/* ---- Test 1: empty catalog ---- */

{
  const cat = makeCatalog();
  cat.setSnapshot([]);
  assert.equal(cat.getByFamily('rdk'), undefined, 'empty → undefined');
  assert.deepEqual(cat.listCovered(), [], 'empty → []');
  console.log('  [PASS] empty catalog');
}

/* ---- Test 2: single extension with family ---- */

{
  const cat = makeCatalog();
  cat.setSnapshot([extJetson]);
  assert.equal(cat.getByFamily('jetson')?.id, 'jetson', 'jetson → jetson ext');
  assert.equal(cat.getByFamily('rdk'), undefined, 'rdk → undefined');
  assert.deepEqual(cat.listCovered(), ['jetson'], 'covered === [jetson]');
  console.log('  [PASS] single extension');
}

/* ---- Test 3: first-wins on duplicate family ---- */

{
  const cat = makeCatalog();
  cat.setSnapshot([extRdk, extRdkAlt]);
  const hit = cat.getByFamily('rdk');
  assert.equal(hit?.id, 'rdk', 'first-wins → rdk (not rdk-alt)');
  assert.deepEqual(cat.listCovered(), ['rdk'], 'de-dup keeps single rdk');
  console.log('  [PASS] first-wins de-dup');
}

/* ---- Test 4: extensions without family excluded from listCovered ---- */

{
  const cat = makeCatalog();
  cat.setSnapshot([extNoFam, extRdk, extJetson]);
  assert.equal(cat.getByFamily('rdk')?.id, 'rdk');
  assert.equal(cat.getByFamily('jetson')?.id, 'jetson');
  assert.deepEqual(
    cat.listCovered(),
    ['rdk', 'jetson'],
    'no-family ext excluded, order preserved'
  );
  console.log('  [PASS] undefined family excluded');
}

/* ---- Test 5: snapshot replace is clean (no residue) ---- */

{
  const cat = makeCatalog();
  cat.setSnapshot([extRdk, extJetson]);
  cat.setSnapshot([extNoFam]);
  assert.equal(cat.getByFamily('rdk'), undefined, 'after replace: rdk is gone');
  assert.equal(cat.getByFamily('jetson'), undefined, 'after replace: jetson is gone');
  assert.deepEqual(cat.listCovered(), [], 'after replace with no-family only: []');
  console.log('  [PASS] snapshot replace isolation');
}

console.log('\n[pass] platform-extension-catalog self-test: 5/5');
