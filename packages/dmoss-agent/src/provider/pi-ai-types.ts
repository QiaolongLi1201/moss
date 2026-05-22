/**
 * pi-ai type boundary — the ONLY file in Moss core (besides the adapter)
 * that imports from @mariozechner/pi-ai. All other core files import from
 * this re-export file so the pi-ai dependency is isolated to a single point.
 *
 * Exception: llm-provider-stream-adapter.ts is the adapter boundary itself
 * and imports directly from pi-ai.
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
