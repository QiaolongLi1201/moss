#!/usr/bin/env node
/**
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/workspace-paths.spec.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyWorkspacePaths } from '../dist/utils/workspace-paths.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dmoss-workspace-paths-'));

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

try {
  writeFile(path.join(workspace, '.dmoss-runtime', 'sessions', 'old.jsonl'), '{"type":"message"}\n');
  writeFile(path.join(workspace, '.dmoss-runtime', 'memory', 'index.json'), '[]\n');
  writeFile(path.join(workspace, '.dmoss-runtime', 'checkpoints', 'cli-old', '001.json'), '{}\n');
  writeFile(path.join(workspace, '.dmoss-runtime', 'attachments', 'clipboard.txt'), 'clip\n');
  writeFile(path.join(workspace, '.dmoss', 'config.json'), '{"profile":"balanced"}\n');
  writeFile(path.join(workspace, 'skills', 'learned', 'recover-usb.md'), '# Recover USB\n');
  writeFile(path.join(workspace, 'skills', 'rdk-camera', 'SKILL.md'), '# RDK Camera\n');
  writeFile(path.join(workspace, 'skill-candidates', 'candidate-1', 'candidate.json'), '{}\n');
  writeFile(path.join(workspace, 'agent', 'skills', 'local-agent', 'SKILL.md'), '# Local Agent\n');

  const migration = migrateLegacyWorkspacePaths(workspace);

  assert.equal(migration.paths.runtimeDir, path.join(workspace, '.moss'));
  assert(fs.existsSync(path.join(workspace, '.moss', 'sessions', 'old.jsonl')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'memory', 'index.json')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'checkpoints', 'cli-old', '001.json')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'attachments', 'clipboard.txt')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'config.json')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'skills', 'learned', 'recover-usb.md')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'skills', 'rdk-camera', 'SKILL.md')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'skills', 'candidates', 'candidate-1', 'candidate.json')));
  assert(fs.existsSync(path.join(workspace, '.moss', 'agent', 'skills', 'local-agent', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(workspace, '.dmoss-runtime')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.dmoss')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'skill-candidates')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'agent')), false);

  console.log('[PASS] workspace path migration moves legacy Moss data into .moss');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
