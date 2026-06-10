#!/usr/bin/env node
/**
 * `moss mcp add/list/remove` — manage MCP servers without hand-editing JSON.
 * The file written must round-trip through the runtime loader
 * (loadMcpConfigWithDiagnostics) unchanged.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-mcp-command.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMcpCommand } from '../dist/cli/mcp-command.js';
import { loadMcpConfigWithDiagnostics } from '../dist/mcp/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-mcp-cmd-'));
const mcpPath = path.join(tmp, 'mcp.json');
const userConfigPath = path.join(tmp, 'config.json');
fs.writeFileSync(userConfigPath, JSON.stringify({ mcp: { configPath: mcpPath } }));
process.env.DMOSS_CONFIG_FILE = userConfigPath;

function withCapturedStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

function resetExit() {
  const code = process.exitCode;
  process.exitCode = undefined;
  return code;
}

// ── add creates the file with runtime-loadable schema ─────────────
{
  const out = withCapturedStderr(() =>
    runMcpCommand(['add', 'fs', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/data', '--env', 'TOKEN=abc', '--timeout-ms', '5000'], tmp),
  );
  assert.notEqual(resetExit(), 1, out);
  assert.match(out, /added "fs"/);
  const { config, diagnostics } = loadMcpConfigWithDiagnostics(mcpPath);
  assert.ok(config, `runtime loader must accept the file: ${JSON.stringify(diagnostics)}`);
  assert.deepEqual(config.mcpServers.fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '/data']);
  assert.equal(config.mcpServers.fs.env.TOKEN, 'abc');
  assert.equal(config.mcpServers.fs.requestTimeoutMs, 5000);
  console.log('  [PASS] mcp add writes a runtime-loadable config');
}

// ── duplicate add is refused without --force ──────────────────────
{
  const out = withCapturedStderr(() => runMcpCommand(['add', 'fs', 'node', 'other.js'], tmp));
  assert.equal(resetExit(), 1, 'duplicate add must fail');
  assert.match(out, /already exists/);
  const forced = withCapturedStderr(() => runMcpCommand(['add', 'fs', 'node', 'other.js', '--force'], tmp));
  assert.notEqual(resetExit(), 1, forced);
  const { config } = loadMcpConfigWithDiagnostics(mcpPath);
  assert.equal(config.mcpServers.fs.command, 'node');
  console.log('  [PASS] duplicate names need --force');
}

// ── list shows servers and the disabled hint ──────────────────────
{
  const out = withCapturedStderr(() => runMcpCommand(['list'], tmp));
  assert.notEqual(resetExit(), 1, out);
  assert.match(out, /fs {2}node other\.js/);
  assert.match(out, /mcp disabled — run: moss config set mcp\.enabled true/);
  console.log('  [PASS] mcp list shows servers and enable hint');
}

// ── remove deletes the entry; unknown name fails clearly ──────────
{
  let out = withCapturedStderr(() => runMcpCommand(['remove', 'fs'], tmp));
  assert.notEqual(resetExit(), 1, out);
  assert.match(out, /removed "fs"/);
  out = withCapturedStderr(() => runMcpCommand(['remove', 'fs'], tmp));
  assert.equal(resetExit(), 1);
  assert.match(out, /is not configured/);
  console.log('  [PASS] mcp remove works and reports unknown names');
}

// ── bad usage prints usage and exits 1 ────────────────────────────
{
  const out = withCapturedStderr(() => runMcpCommand(['add'], tmp));
  assert.equal(resetExit(), 1);
  assert.match(out, /Usage:/);
  console.log('  [PASS] bad usage shows help');
}

delete process.env.DMOSS_CONFIG_FILE;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('[PASS] moss mcp command');
