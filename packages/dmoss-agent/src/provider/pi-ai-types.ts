/**
 * pi-ai type boundary — the ONLY file in Moss core (besides the adapter)
 * that imports from @mariozechner/pi-ai. All other core files import from
 * this re-export file so the pi-ai dependency is isolated to a single point.
 *
 * Also re-exports adapter-specific types for convenience.
 */

export {
  EventStream,
} from '@mariozechner/pi-ai';

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
