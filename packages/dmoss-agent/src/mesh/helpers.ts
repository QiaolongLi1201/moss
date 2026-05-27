import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import type { HostAddressResolver } from './types.js';
import { DNS_CHECK_TIMEOUT_MS } from './types.js';

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i.test(host.trim());
}

export function isPrivateOrLoopbackHost(host: string): boolean {
  return /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|\[::1\]|localhost|fe80:|fc00:|fd00:)/i.test(host.trim());
}

export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

export async function resolveHostAddressesWithTimeout(
  hostname: string,
  resolver: HostAddressResolver,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('mesh discovery DNS timeout')), DNS_CHECK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function isPrivateOrLoopbackTarget(
  host: string,
  resolver: HostAddressResolver = resolveHostAddresses,
): Promise<boolean> {
  if (isPrivateOrLoopbackHost(host)) return true;
  try {
    const addresses = await resolveHostAddressesWithTimeout(host, resolver);
    return addresses.some(isPrivateOrLoopbackHost);
  } catch {
    return true;
  }
}

export function secureEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

/** Set `DMOSS_MESH_VERBOSE=true` to print mesh traffic and (from CLI) startup / peer logs. */
export function isMeshVerboseEnabled(): boolean {
  return process.env.DMOSS_MESH_VERBOSE === 'true';
}

export function resolveAnnounceHost(listenHost: string | undefined): string {
  const listen = listenHost ?? '127.0.0.1';
  if (listen === '0.0.0.0' || listen === '::') {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          return info.address;
        }
      }
    }
    return '127.0.0.1';
  }
  return listen;
}
