/**
 * Per-session monotonic epoch for runAgentLoop invocations. When a new run
 * starts for the same sessionKey before the previous async IIFE finishes, stale
 * pushes are dropped so the UI/event stream cannot interleave two runs.
 */

import type { EventStream } from '@mariozechner/pi-ai';
import type { MiniAgentEvent, MiniAgentResult } from './agent-events.js';

const runEpochBySessionKey = new Map<string, number>();

export function bumpAgentLoopRunEpoch(sessionKey: string): number {
  const next = (runEpochBySessionKey.get(sessionKey) ?? 0) + 1;
  runEpochBySessionKey.set(sessionKey, next);
  return next;
}

/**
 * Monkey-patch stream.push so events from superseded runs are dropped.
 * Does not wrap stream.end — terminal resolution stays tied to the stream instance.
 */
export function guardMiniAgentStreamPush(
  stream: EventStream<MiniAgentEvent, MiniAgentResult>,
  sessionKey: string,
  runEpoch: number,
): void {
  const protoPush = stream.push.bind(stream) as (e: MiniAgentEvent) => void;
  (stream as unknown as { push: (e: MiniAgentEvent) => void }).push = (
    e: MiniAgentEvent,
  ) => {
    if ((runEpochBySessionKey.get(sessionKey) ?? 0) !== runEpoch) return;
    protoPush(e);
  };
}
