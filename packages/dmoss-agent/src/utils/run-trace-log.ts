/**
 * Structured trace logging for agent runs — aids full-chain debugging via grep / jq.
 *
 * 通过 logger 统一输出：默认级别 info；`DMOSS_LOG_LEVEL=debug` 时也生效；
 * `DMOSS_LOG_JSON=1` 时自动转 JSON 行。scope = `agent:trace:<kind>` 便于过滤。
 */
import { getRootLogger } from '../logger.js';

export function dmossRunTrace(
  kind: 'queue_wait' | 'run_start' | 'run_done' | 'run_error',
  fields: Record<string, unknown>,
): void {
  const log = getRootLogger().child(`agent:trace:${kind}`);
  const level = kind === 'run_error' ? 'warn' : 'info';
  log[level](kind, fields);
}
