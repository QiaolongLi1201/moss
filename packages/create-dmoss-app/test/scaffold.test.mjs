import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const cli = path.resolve('index.mjs');

test('prints usage', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /create-dmoss-app <project-name>/);
  assert.match(result.stdout, /--skip-install/);
});

test('scaffolds minimal project without installing dependencies', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dmoss-app-'));
  const result = spawnSync(process.execPath, [cli, 'demo-agent', '--skip-install'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'demo-agent');
  const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));

  assert.equal(packageJson.name, 'demo-agent');
  assert.equal(packageJson.scripts.typecheck.includes('tsc --noEmit'), true);
  assert.equal(fs.existsSync(path.join(target, 'index.ts')), true);
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /Node\.js 22\.16 or newer/);
  assert.match(readme, /OpenSSH Client/);
  assert.match(readme, /Windows PowerShell/);
  assert.match(readme, /\$env:DMOSS_API_KEY/);
  assert.match(readme, /Windows cmd\.exe/);
  assert.match(readme, /set DMOSS_API_KEY=your-key && npm start/);
  assert.match(readme, /Copy-Item mcp\.json\.example mcp\.json/);
  assert.match(readme, /copy mcp\.json\.example mcp\.json/);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('scaffolds openai template without installing dependencies', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dmoss-app-openai-'));
  const result = spawnSync(process.execPath, [
    cli,
    'openai-agent',
    '--template',
    'openai',
    '--skip-install',
  ], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const source = fs.readFileSync(path.join(cwd, 'openai-agent', 'index.ts'), 'utf8');
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /OpenAILLMProvider/);
});
