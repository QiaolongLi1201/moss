#!/usr/bin/env node
/**
 * Long-horizon truncation surfacing.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/cli-output-max-turns.spec.mjs
 */
import assert from 'node:assert/strict';
import { createCliRunRenderer } from '../dist/cli/output.js';

function createCapture() {
  let text = '';
  return {
    stream: { write(chunk) { text += String(chunk); return true; } },
    read() { return text; },
  };
}

// RED before fix: a max_turns run printed only a newline, looking like normal
// completion. The user must be told it is truncated and how to continue.
{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({ detailMode: 'progress', stdout: stdout.stream, stderr: stderr.stream });
  renderer.handle({ type: 'text_delta', delta: 'Partial work so far' });
  renderer.handle({ type: 'done', result: { response: 'Partial work so far', toolCalls: [], toolResults: [], stopReason: 'max_turns_reached' } });
  assert.match(stderr.read(), /turn limit/i, 'truncation must be announced');
  assert.match(stderr.read(), /moss resume --last/, 'must tell the user how to continue');
  assert.equal(stdout.read(), 'Partial work so far\n', 'the partial answer still goes to stdout');
}

// Even in quiet mode the hard stop must surface (it is not progress noise).
{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({ detailMode: 'quiet', stdout: stdout.stream, stderr: stderr.stream });
  renderer.handle({ type: 'text_delta', delta: 'half' });
  renderer.handle({ type: 'done', result: { response: 'half', toolCalls: [], toolResults: [], stopReason: 'tool_followup_cap_reached' } });
  assert.match(stderr.read(), /moss resume --last/, 'quiet mode still warns on truncation');
}

// A NORMAL completion must stay silent (no false truncation banner) — this also
// guards the existing quiet-mode empty-stderr contract.
{
  const stdout = createCapture();
  const stderr = createCapture();
  const renderer = createCliRunRenderer({ detailMode: 'quiet', stdout: stdout.stream, stderr: stderr.stream });
  renderer.handle({ type: 'text_delta', delta: 'Only answer' });
  renderer.handle({ type: 'done', result: { response: 'Only answer', toolCalls: [], toolResults: [], stopReason: 'end_turn' } });
  assert.equal(stderr.read(), '', 'normal completion prints no truncation notice');
  assert.equal(stdout.read(), 'Only answer\n');
}

console.log('[PASS] CLI renderer surfaces max_turns truncation with a resume hint');
