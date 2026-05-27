/**
 * Minimal internal logger for dmoss-memory.
 *
 * dmoss-memory is a standalone package with no dependency on @dmoss/agent.
 * This module provides structured, prefixed log output without pulling in
 * the full logger framework. Hosts that need structured logging should
 * configure their own logger at the application level.
 */

const PREFIX = '[memory]';

export function memoryWarn(msg: string, data?: unknown): void {
  if (data !== undefined) {
    console.warn(`${PREFIX} ${msg}`, data);
  } else {
    console.warn(`${PREFIX} ${msg}`);
  }
}
