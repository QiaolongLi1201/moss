import type {
  AgentHooks,
  InputGuardrailDecision,
  InputGuardrailRequest,
  OutputGuardrailDecision,
  OutputGuardrailRequest,
} from '../core/agent/agent-hooks.js';
import type { ResolvedCliConfig, ResolvedGuardrailsConfig, ResolvedTextGuardrailConfig } from './config.js';

interface CompiledPattern {
  label: string;
  regex: RegExp;
}

interface CompiledTextGuardrail {
  block: CompiledPattern[];
  redact: CompiledPattern[];
}

interface CompiledGuardrails {
  input: CompiledTextGuardrail;
  output: CompiledTextGuardrail;
}

function hasConfiguredGuardrails(config: ResolvedGuardrailsConfig): boolean {
  return config.input.blockPatterns.length > 0 ||
    config.input.redactPatterns.length > 0 ||
    config.output.blockPatterns.length > 0 ||
    config.output.redactPatterns.length > 0;
}

function compilePattern(pattern: string, source: string): CompiledPattern {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${source} pattern "${pattern}": ${message}`);
  }
  if (regex.test('')) {
    throw new Error(`Invalid ${source} pattern "${pattern}": pattern must not match empty text`);
  }
  return { label: pattern, regex: new RegExp(pattern, 'g') };
}

function compilePatterns(patterns: readonly string[], source: string): CompiledPattern[] {
  return patterns.map((pattern) => compilePattern(pattern, source));
}

function compileTextGuardrail(config: ResolvedTextGuardrailConfig, source: string): CompiledTextGuardrail {
  return {
    block: compilePatterns(config.blockPatterns, `${source}.blockPatterns`),
    redact: compilePatterns(config.redactPatterns, `${source}.redactPatterns`),
  };
}

function compileGuardrails(config: ResolvedGuardrailsConfig): CompiledGuardrails {
  return {
    input: compileTextGuardrail(config.input, 'guardrails.input'),
    output: compileTextGuardrail(config.output, 'guardrails.output'),
  };
}

function firstMatch(patterns: readonly CompiledPattern[], text: string): CompiledPattern | null {
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return pattern;
  }
  return null;
}

function redact(patterns: readonly CompiledPattern[], text: string): string {
  let next = text;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    next = next.replace(pattern.regex, '[redacted]');
  }
  return next;
}

async function runInputGuardrail(
  request: InputGuardrailRequest,
  configured: CompiledTextGuardrail,
  baseHook: AgentHooks['onInputGuardrail'],
): Promise<InputGuardrailDecision> {
  const blocked = firstMatch(configured.block, request.userMessage);
  if (blocked) {
    return { approved: false, reason: `Blocked by configured input guardrail pattern: ${blocked.label}` };
  }

  const userMessage = redact(configured.redact, request.userMessage);
  const normalizedRequest = userMessage === request.userMessage ? request : { ...request, userMessage };
  const baseDecision = baseHook ? await baseHook(normalizedRequest) : { approved: true as const };
  if (!baseDecision.approved) return baseDecision;
  return baseDecision.userMessage === undefined && userMessage !== request.userMessage
    ? { approved: true, userMessage }
    : baseDecision;
}

async function runOutputGuardrail(
  request: OutputGuardrailRequest,
  configured: CompiledTextGuardrail,
  baseHook: AgentHooks['onOutputGuardrail'],
): Promise<OutputGuardrailDecision> {
  const blocked = firstMatch(configured.block, request.response);
  if (blocked) {
    return {
      approved: false,
      reason: `Blocked by configured output guardrail pattern: ${blocked.label}`,
    };
  }

  const response = redact(configured.redact, request.response);
  const normalizedRequest = response === request.response ? request : { ...request, response };
  const baseDecision = baseHook ? await baseHook(normalizedRequest) : { approved: true as const };
  if (!baseDecision.approved) return baseDecision;
  return baseDecision.response === undefined && response !== request.response
    ? { approved: true, response }
    : baseDecision;
}

export function createConfiguredGuardrailHooks(
  config: Pick<ResolvedCliConfig, 'guardrails'>,
  baseHooks: AgentHooks = {},
): AgentHooks {
  if (!hasConfiguredGuardrails(config.guardrails)) return baseHooks;
  const configured = compileGuardrails(config.guardrails);
  return {
    ...baseHooks,
    onInputGuardrail: (request) => runInputGuardrail(request, configured.input, baseHooks.onInputGuardrail),
    onOutputGuardrail: (request) => runOutputGuardrail(request, configured.output, baseHooks.onOutputGuardrail),
  };
}
