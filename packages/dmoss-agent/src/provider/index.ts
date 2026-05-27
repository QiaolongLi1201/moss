export {
  FailoverError,
  isFailoverError,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isConnectionError,
  isServerError,
  isTransientError,
  isAuthError,
  classifyFailoverReason,
  isFailoverErrorMessage,
  retryAsync,
  describeError,
} from './errors.js';

export type {
  FailoverReason,
  RetryOptions,
} from './errors.js';

// LLM Provider types (from core)
export type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
  LLMMessage,
  LLMContentBlock,
  LLMToolDeclaration,
} from '../core/llm/llm-provider.js';

// pi-ai adapter
export { PiAiLLMProvider } from './pi-ai-adapter.js';
export type {
  PiAiModelInfo,
  PiAiStreamFunction,
  PiAiStreamEvent,
  PiAiLLMProviderConfig,
} from './pi-ai-adapter.js';

// Built-in providers (native fetch, no SDK dependency)
export { AnthropicLLMProvider } from './anthropic.js';
export type { AnthropicLLMProviderConfig } from './anthropic.js';
export { OpenAILLMProvider } from './openai.js';
export type { OpenAILLMProviderConfig } from './openai.js';

// keep-alive dispatcher (chat-tool-llm-overlap)
export {
  ensureKeepAliveDispatcherInstalled,
  wasConnectionReused,
} from './keep-alive-dispatcher.js';

// Runtime retry (2026-05-01-moss-reliability-fallback-ux G-2)
export { runWithProviderRetry } from './runtime-retry.js';
export type { RuntimeRetryOptions, RuntimeRetryInfo } from './runtime-retry.js';

// Provider error classification (2026-04-24-provider-error-ux-surface MVP)
export {
  classifyProviderError,
  renderProviderErrorSurface,
  sanitizeRawErrorForDetail,
} from './error-classify.js';
export type {
  ProviderErrorCategory,
  ProviderErrorAction,
  ProviderErrorSurface,
  ProviderErrorInput,
} from './error-classify.js';
