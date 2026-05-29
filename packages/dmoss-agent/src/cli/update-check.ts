import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = '@rdk-moss/agent';
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 800;

export interface UpdateCheckOptions {
  configDir: string;
  currentVersion: string;
  now?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
  command: string;
}

interface VersionCache {
  checkedAt?: number;
  latestVersion?: string;
}

function cachePath(configDir: string): string {
  return path.join(configDir, 'latest-version.json');
}

function readCache(configDir: string): VersionCache | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(configDir), 'utf-8')) as VersionCache;
  } catch {
    return null;
  }
}

function writeCache(configDir: string, latestVersion: string, now: number): void {
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      cachePath(configDir),
      `${JSON.stringify({ checkedAt: now, latestVersion }, null, 2)}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch {
    // Update checks are best-effort and must never affect startup.
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const right = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function noticeFor(currentVersion: string, latestVersion: string): UpdateNotice | null {
  if (currentVersion === 'unknown') return null;
  if (compareVersions(latestVersion, currentVersion) <= 0) return null;
  return {
    currentVersion,
    latestVersion,
    command: `npm i -g ${PACKAGE_NAME}@latest`,
  };
}

export function formatUpdateNotice(notice: UpdateNotice): string {
  return `[update] ${PACKAGE_NAME} ${notice.currentVersion} -> ${notice.latestVersion} available. Run: ${notice.command}`;
}

export async function checkForCliUpdate(options: UpdateCheckOptions): Promise<UpdateNotice | null> {
  const now = options.now ?? Date.now();
  const cached = readCache(options.configDir);
  if (
    cached?.latestVersion &&
    cached.checkedAt &&
    now - cached.checkedAt < CACHE_MAX_AGE_MS
  ) {
    return noticeFor(options.currentVersion, cached.latestVersion);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown };
    if (typeof body.version !== 'string') return null;
    writeCache(options.configDir, body.version, now);
    return noticeFor(options.currentVersion, body.version);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function startCliUpdateCheck(options: UpdateCheckOptions & {
  onNotice?: (message: string) => void;
}): void {
  void checkForCliUpdate(options).then((notice) => {
    if (!notice) return;
    (options.onNotice ?? ((message) => process.stderr.write(`${message}\n`)))(formatUpdateNotice(notice));
  });
}
