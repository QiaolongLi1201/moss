/**
 * pi-ai type boundary — this file keeps @mariozechner/pi-ai as a type-only
 * dependency for Moss core. Runtime stream primitives come from our local
 * implementation so CLI startup is not affected by pi-ai import side effects.
 *
 * Also re-exports adapter-specific types for convenience.
 */

export {
  EventStream,
} from './event-stream.js';

export type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  ToolCall,
  Usage,
} from '@mariozechner/pi-ai';

// Adapter-specific types (convenience re-exports)
export type { PiAiModelInfo, PiAiStreamEvent } from './pi-ai-wire-format.js';
export type { PiAiStreamFunction, PiAiLLMProviderConfig } from './pi-ai-adapter.js';
