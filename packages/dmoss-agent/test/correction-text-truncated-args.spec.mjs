#!/usr/bin/env node
/**
 * A recoverable turn caused by a TRUNCATED tool-call argument (a large file
 * sent to one write_file, JSON cut off mid-stream) must steer the model to
 * chunk the work — not re-emit the same oversized payload. Regression for the
 * dogfood bug where a ~10KB single-file write looped to a fatal exit.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import { correctionTextForTurnError } from '../dist/core/loop/agent-loop.js';

const chunkRe = /smaller pieces|apply_patch/i;

// The exact errors the OpenAI-compatible / OpenAI / Anthropic providers throw
// when tool-call argument JSON is truncated.
for (const msg of [
  'CLI OpenAI-compatible provider: malformed tool call arguments for write_file: Unterminated string in JSON at position 8601',
  'OpenAI provider: malformed tool call arguments for write_file',
  'Unexpected end of JSON input',
]) {
  const text = correctionTextForTurnError(new Error(msg));
  assert.match(text, chunkRe, `truncated-args error should yield chunking guidance: ${msg}`);
  assert.match(text, /Do NOT repeat the same large call/i);
}

// A generic recoverable error keeps the neutral re-state message (no false
// "your file was too large" guidance).
const generic = correctionTextForTurnError(new Error('LLM stream error: terminated'));
assert.doesNotMatch(generic, chunkRe);
assert.match(generic, /re-state your last action/i);

// Non-Error inputs must not throw.
assert.match(correctionTextForTurnError('Unterminated string in JSON'), chunkRe);
assert.doesNotMatch(correctionTextForTurnError(undefined), chunkRe);

console.log('[PASS] correction text: truncated tool-args steer to chunked writes, generic errors unchanged');
