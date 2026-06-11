import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '../..');
const scriptPath = path.join(workspaceRoot, 'scripts', 'preview-welcome.mjs');
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

const result = spawnSync(process.execPath, [scriptPath], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  timeout: 5000,
});

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /Moss/);
assert.match(result.stdout, new RegExp(`v${packageJson.version.replaceAll('.', '\\.')}`));
assert.match(result.stdout, /built-in model/);
assert.match(result.stdout, /Ask Moss for code, board, or ROS help/);
assert.doesNotMatch(result.stdout, /rdstudio-web/);
assert.doesNotMatch(result.stdout, /deepseek-v4-pro/);
assert.doesNotMatch(result.stderr, /Raw mode is not supported/);

console.log('[PASS] preview-welcome script renders a non-TTY static frame');
