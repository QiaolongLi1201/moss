import { spawnSync } from 'node:child_process';
import { checkForCliUpdate, formatUpdateNotice } from './update-check.js';

export async function runCliUpdate(options: {
  configDir: string;
  currentVersion: string;
  packageName?: string;
  npmBin?: string;
}): Promise<number> {
  const packageName = options.packageName ?? '@rdk-moss/agent';
  const notice = await checkForCliUpdate({
    configDir: options.configDir,
    currentVersion: options.currentVersion,
    timeoutMs: 2500,
    forceRefresh: true,
  });

  if (notice) {
    process.stderr.write(`${formatUpdateNotice(notice)}\n`);
  } else {
    process.stderr.write(`[update] Installing latest ${packageName}. Current version: ${options.currentVersion}\n`);
  }

  const result = spawnSync(options.npmBin ?? 'npm', ['i', '-g', `${packageName}@latest`], {
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`[update] failed to run npm: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
