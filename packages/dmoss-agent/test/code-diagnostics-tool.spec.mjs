#!/usr/bin/env node
/**
 * Test: code_diagnostics tool (auto-detection, pass/fail framing, explicit command).
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codeDiagnosticsTool } from '../dist/tools/code-diagnostics.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-diag-'));
const CTX = { workspaceDir: dir, sessionKey: 'test' };

console.log('[TEST] auto-detects a package.json check script and reports pass');
{
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 't', scripts: { check: 'node -e "process.exit(0)"' } }),
  );
  const out = await codeDiagnosticsTool.execute({}, CTX);
  assert.match(out, /package\.json script "check"/, 'should auto-detect the check script');
  assert.match(out, /Passed/, 'exit 0 should be framed as passed');
}

console.log('[TEST] an explicit failing command is framed as diagnostics found');
{
  const failingChecker = path.join(dir, 'fail-check.mjs');
  await fs.writeFile(failingChecker, "console.error('type error on line 4'); process.exit(2);\n");
  const out = await codeDiagnosticsTool.execute(
    { command: `node ${JSON.stringify(failingChecker)}` },
    CTX,
  );
  assert.match(out, /Diagnostics reported \(exit 2\)/, 'non-zero exit should be framed as diagnostics');
  assert.match(out, /type error on line 4/, 'checker output should be included');
}

console.log('[TEST] no detectable checker yields actionable guidance');
{
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-diag-empty-'));
  const out = await codeDiagnosticsTool.execute({}, { workspaceDir: empty, sessionKey: 'test' });
  assert.match(out, /No diagnostic command detected/);
  assert.match(out, /ruff check|mypy|cargo check/, 'should suggest passing an explicit command');
  await fs.rm(empty, { recursive: true, force: true });
}

console.log('[TEST] dangerous commands are blocked');
{
  const out = await codeDiagnosticsTool.execute({ command: 'rm -rf /' }, CTX);
  assert.match(out, /blocked/i);
}

await fs.rm(dir, { recursive: true, force: true });
console.log('\n[PASS] code_diagnostics tool tests');
