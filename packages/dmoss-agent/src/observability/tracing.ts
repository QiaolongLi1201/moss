/**
 * Agent loop tracing — lightweight instrumentation layer.
 *
 * Provides a tracer interface for instrumenting agent loop execution
 * with spans for turns, tool calls, and LLM requests. Hosts can plug in
 * OpenTelemetry or any other tracing backend.
 *
 * When no tracer is configured, all calls are no-ops.
 */

// ── Types ───────────────────────────────────────────────────────

export interface TraceSpan {
  /** Set a string attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an event within the span. */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  /** Set the span status. */
  setStatus(ok: boolean, message?: string): void;
  /** End the span. */
  end(): void;
}

export interface Tracer {
  /** Start a new span. Returns a no-op span when tracing is disabled. */
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parent?: TraceSpan,
  ): TraceSpan;
}

// ── No-op tracer ────────────────────────────────────────────────

const noopSpan: TraceSpan = {
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

const noopTracer: Tracer = {
  startSpan(_name, _attrs, _parent) {
    return noopSpan;
  },
};

// ── Simple console tracer (for dev/debug) ───────────────────────

function createConsoleTracer(): Tracer {
  return {
    startSpan(name, attributes, parent) {
      const start = Date.now();
      const attrs = attributes ? ` ${JSON.stringify(attributes)}` : '';
      const parentInfo = parent ? ` (parent)` : '';
      console.error(`[trace] ▶ ${name}${attrs}${parentInfo}`);
      return {
        setAttribute(key, value) {
          console.error(`[trace]   ${name}.${key} = ${value}`);
        },
        addEvent(eventName, eventAttrs) {
          const ea = eventAttrs ? ` ${JSON.stringify(eventAttrs)}` : '';
          console.error(`[trace]   ${name} :: ${eventName}${ea}`);
        },
        setStatus(ok, message) {
          const status = ok ? 'OK' : 'ERROR';
          const msg = message ? ` (${message})` : '';
          console.error(`[trace]   ${name} status=${status}${msg}`);
        },
        end() {
          const ms = Date.now() - start;
          console.error(`[trace] ◀ ${name} (${ms}ms)`);
        },
      };
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────

let _globalTracer: Tracer = noopTracer;
let _traceRedactor: ((text: string) => string) | null = null;

/**
 * Configure the global tracer. Call once at startup.
 * Pass `"console"` for debug output, or a custom Tracer instance.
 */
export function setTracer(tracer: Tracer | 'console'): void {
  if (tracer === 'console') {
    _globalTracer = createConsoleTracer();
  } else {
    _globalTracer = tracer;
  }
}

/**
 * Set a redaction function applied to error messages in trace spans
 * before they reach the tracer backend. Use this to prevent secrets
 * from leaking through tracing output.
 */
export function setTraceRedactor(fn: (text: string) => string): void {
  _traceRedactor = fn;
}

function redactTraceMessage(text: string): string {
  return _traceRedactor ? _traceRedactor(text) : text;
}

/** Get the current tracer (never null). */
export function getTracer(): Tracer {
  return _globalTracer;
}

/**
 * Run a function within a trace span. The span is automatically ended
 * when the function returns or throws.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: TraceSpan) => Promise<T>,
  parent?: TraceSpan,
): Promise<T> {
  const span = _globalTracer.startSpan(name, attributes, parent);
  try {
    const result = await fn(span);
    span.setStatus(true);
    return result;
  } catch (err) {
    span.setStatus(false, redactTraceMessage(err instanceof Error ? err.message : String(err)));
    throw err;
  } finally {
    span.end();
  }
}

// ── Agent-loop instrumentation helpers ──────────────────────────

/**
 * Create trace attributes for an agent turn.
 */
export function turnAttributes(
  runId: string,
  turn: number,
  model: string,
): Record<string, string | number | boolean> {
  return { runId, turn, model };
}

/**
 * Create trace attributes for a tool execution.
 */
export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string,
): Record<string, string | number | boolean> {
  return { runId, toolName, toolCallId };
}

/**
 * Create trace attributes for an LLM request.
 */
export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number,
): Record<string, string | number | boolean> {
  return { runId, model, inputTokens };
}