#!/usr/bin/env node
/**
 * Mock LLM Provider that replays deterministic transcripts for E2E testing.
 *
 * Each call to complete() or stream() returns the next entry from the
 * transcript array, in order. No real LLM calls are made.
 */

/**
 * @typedef {Object} TranscriptEntry
 * @property {string} [text] - the assistant text response
 * @property {'end_turn'|'tool_use'} [stopReason] - stop reason (default: end_turn)
 * @property {Array<{name:string, input:Record<string,unknown>}>} [toolCalls] - tool calls to return
 * @property {{inputTokens:number, outputTokens:number}} [usage] - token usage
 */

/**
 * Create a mock LLMProvider that replays from a transcript.
 * @param {string} id
 * @param {string} displayName
 * @param {TranscriptEntry[]} transcript
 */
export function createMockTranscriptProvider(id, displayName, transcript) {
  let turnIndex = 0;

  return {
    id,
    displayName,

    async complete(_options) {
      const entry = transcript[turnIndex];
      turnIndex++;
      if (!entry) {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '(no more transcript entries)' }],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }

      /** @type {Array<{type:string, text?:string, id?:string, name?:string, input?:Record<string,unknown>}>} */
      const content = [];
      if (entry.text) {
        content.push({ type: 'text', text: entry.text });
      }
      if (entry.toolCalls) {
        for (const tc of entry.toolCalls) {
          content.push({
            type: 'tool_use',
            id: `tc_${turnIndex}_${tc.name}`,
            name: tc.name,
            input: tc.input,
          });
        }
      }

      // Small delay to simulate async work
      await new Promise((r) => setTimeout(r, 5));

      const hasToolCalls = entry.toolCalls && entry.toolCalls.length > 0;

      return {
        stopReason: hasToolCalls ? 'tool_use' : (entry.stopReason ?? 'end_turn'),
        content,
        usage: entry.usage ?? { inputTokens: 10, outputTokens: 20 },
      };
    },

    async stream(options, onEvent) {
      const result = await this.complete(options);

      onEvent({ type: 'message_start' });

      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          onEvent({ type: 'content_block_start' });
          onEvent({ type: 'content_block_delta', text: block.text });
          onEvent({ type: 'content_block_stop' });
        } else if (block.type === 'tool_use') {
          onEvent({
            type: 'content_block_start',
            toolUse: { id: block.id, name: block.name },
          });
          onEvent({ type: 'content_block_delta', partialJson: JSON.stringify(block.input) });
          onEvent({ type: 'content_block_stop' });
        }
      }

      onEvent({ type: 'message_delta', stopReason: result.stopReason });
      onEvent({ type: 'message_stop' });

      return result;
    },

    async countTokens(text) {
      return Math.ceil(text.length / 4);
    },
  };
}