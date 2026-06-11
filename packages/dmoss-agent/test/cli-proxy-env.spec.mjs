import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '../dist/cli.js');

function assertSocksProxyTolerated(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} should tolerate SOCKS proxy env\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /Invalid URL protocol/);
}

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

  assertSocksProxyTolerated(result, 'moss --version');
  assert.match(result.stdout, /moss v\d+\.\d+\.\d+/);
}

{
  const dispatcherUrl = pathToFileURL(path.resolve(__dirname, '../dist/provider/keep-alive-dispatcher.js')).href;
  const undiciUrl = pathToFileURL(path.resolve(__dirname, '../../../node_modules/undici/index.js')).href;
  const code = `
    import { ensureKeepAliveDispatcherInstalled, __resetForTest } from ${JSON.stringify(dispatcherUrl)};
    import { getGlobalDispatcher } from ${JSON.stringify(undiciUrl)};
    __resetForTest();
    await ensureKeepAliveDispatcherInstalled();
    console.log(getGlobalDispatcher().constructor.name);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: socksProxyEnv,
    encoding: 'utf8',
  });

  assertSocksProxyTolerated(result, 'keep-alive dispatcher');
  assert.match(result.stdout, /EnvHttpProxyAgent/);
}

for (const rel of [
  '../dist/provider/pi-ai-types.js',
  '../dist/core/llm/llm-provider-stream-adapter.js',
]) {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, rel)).href;
  const code = `
    await import(${JSON.stringify(moduleUrl)});
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log('ok');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: socksProxyEnv,
    encoding: 'utf8',
  });

  assertSocksProxyTolerated(result, rel);
  assert.match(result.stdout, /ok/);
}

console.log('[PASS] CLI tolerates SOCKS proxy environment during startup');
