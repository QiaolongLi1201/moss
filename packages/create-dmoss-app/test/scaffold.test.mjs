import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const packagesRoot = path.resolve(packageRoot, '..');
const cli = path.join(packageRoot, 'index.mjs');

function packageVersion(packageDir) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packagesRoot, packageDir, 'package.json'), 'utf8'),
  );
  return packageJson.version;
}

const expectedMossDependencyRanges = {
  '@rdk-moss/core': `^${packageVersion('dmoss')}`,
  '@rdk-moss/agent': `^${packageVersion('dmoss-agent')}`,
};

test('prints usage', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /create-dmoss-app <project-name>/);
  assert.match(result.stdout, /--skip-install/);
  assert.match(result.stdout, /Minimal Moss agent with Anthropic API key support/);
  assert.doesNotMatch(result.stdout, /D-Moss/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.description, /Moss agent project/);
  assert.doesNotMatch(packageJson.description, /D-Moss/);
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
  assert.equal(
    packageJson.dependencies['@rdk-moss/core'],
    expectedMossDependencyRanges['@rdk-moss/core'],
  );
  assert.equal(
    packageJson.dependencies['@rdk-moss/agent'],
    expectedMossDependencyRanges['@rdk-moss/agent'],
  );
  assert.equal(packageJson.scripts.typecheck.includes('tsc --noEmit'), true);
  assert.equal(fs.existsSync(path.join(target, 'index.ts')), true);
  assert.equal(fs.existsSync(path.join(target, 'mcp.json.example')), true);
  assert.equal(fs.existsSync(path.join(target, 'README.md')), true);
  const source = fs.readFileSync(path.join(target, 'index.ts'), 'utf8');
  assert.match(source, /ANTHROPIC_API_KEY/);
  assert.match(source, /DMOSS_API_KEY/);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /A Moss agent project/);
  assert.match(readme, /Node\.js 22\.16 or newer/);
  assert.match(readme, /OpenSSH Client/);
  assert.match(readme, /Windows PowerShell/);
  assert.match(readme, /\$env:ANTHROPIC_API_KEY/);
  assert.match(readme, /Windows cmd\.exe/);
  assert.match(readme, /set ANTHROPIC_API_KEY=your-key && npm start/);
  assert.match(readme, /accepts `DMOSS_API_KEY` as a compatibility fallback/);
  assert.match(readme, /Moss Documentation/);
  assert.doesNotMatch(readme, /D-Moss/);
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
  const target = path.join(cwd, 'openai-agent');
  const source = fs.readFileSync(path.join(target, 'index.ts'), 'utf8');
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /OpenAILLMProvider/);
  assert.equal(fs.existsSync(path.join(target, 'mcp.json.example')), true);
  const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  assert.match(readme, /OPENAI_API_KEY=your-key npm start/);
  assert.match(readme, /cp mcp\.json\.example mcp\.json/);
});

test('supports nested target paths and sanitizes package name from the leaf directory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dmoss-app-nested-'));
  const result = spawnSync(process.execPath, [cli, 'apps/My Agent', '--skip-install'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const target = path.join(cwd, 'apps', 'My Agent');
  const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'my-agent');
  assert.equal(fs.existsSync(path.join(cwd, 'My Agent')), false);
  const normalizedStdout = result.stdout.replace(/\\/g, '/');
  assert.match(normalizedStdout, /cd "apps\/My Agent"/);
});
