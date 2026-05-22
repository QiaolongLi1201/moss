/**
 * Abort signal propagation — combines run-level and tool-level abort signals.
 */

import type { Tool, ToolContext } from './tool-types.js';

export function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a as AbortSignal, b as AbortSignal]);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener('abort', onAbort, { once: true });
  b?.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

export function wrapToolWithAbortSignal<T>(tool: Tool<T>, runSignal: AbortSignal): Tool<T> {
  const original = tool.execute;
  return {
    ...tool,
    async execute(input: T, ctx: ToolContext): Promise<string> {
      const combined = combineAbortSignals(ctx.abortSignal, runSignal);
      if (combined?.aborted) {
        throw new Error('Operation aborted');
      }
      return original(input, { ...ctx, abortSignal: combined });
    },
  };
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Operation aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
