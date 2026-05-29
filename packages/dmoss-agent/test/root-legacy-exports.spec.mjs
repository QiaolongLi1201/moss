#!/usr/bin/env node
/**
 * Regression test for root package exports documented in MIGRATION.md.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/root-legacy-exports.spec.mjs
 */

import assert from 'node:assert/strict';
import * as dmossAgent from '../dist/index.js';

// Contract: MIGRATION.md requires these names as @rdk-moss/agent root exports.
// Import dist/ to validate the published artifact, not just TypeScript source.
const documentedLegacyRootExports = [
  'findModuleForFamily',
  'setKnowledgeRegistryForExtensions',
  'applyPlatformExtensionForce',
  'setRegisteredPlatformExtensionsSnapshot',
  'resetPlatformExtensionRegistryForTests',
  'listAppliedPlatformExtensionState',
];

for (const name of documentedLegacyRootExports) {
  assert.equal(
    typeof dmossAgent[name],
    'function',
    `@rdk-moss/agent root export "${name}" must exist because MIGRATION.md imports it from the root package`,
  );
}

console.log('[PASS] root package exports documented legacy migration APIs');
