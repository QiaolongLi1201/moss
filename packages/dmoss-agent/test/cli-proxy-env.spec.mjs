import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

const socksProxyEnv = {
  ...process.env,
  HTTP_PROXY: 'socks5h://127.0.0.1:7890',
  HTTPS_PROXY: 'socks5h://127.0.0.1:7890',
  http_proxy: 'socks5h://127.0.0.1:7890',
  https_proxy: 'socks5h://127.0.0.1:7890',
};

{
  const result = spawnSync(process.execPath, [cliPath, '--version'], {
    env: socksProxyEnv,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `dmoss --version should not import-crash under SOCKS proxy env\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /dmoss v\d+\.\d+\.\d+/);
}

{
  const dispatcherUrl = pathToFileURL(path.resolve(__dirname, '../dist/provider/keep-alive-dispatcher.js')).href;
  const code = `
    import { ensureKeepAliveDispatcherInstalled, __resetForTest } from ${JSON.stringify(dispatcherUrl)};
    __resetForTest();
    await ensureKeepAliveDispatcherInstalled();
    console.log('ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: socksProxyEnv,
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `keep-alive dispatcher should tolerate unsupported proxy env\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /ok/);
}

console.log('[PASS] CLI tolerates SOCKS proxy environment during startup');
