#!/usr/bin/env node
/**
 * Self-test for message conversion round-trip (P1-7).
 *
 * Verifies that toSessionMessages / fromSessionMessages / toLLMMessages
 * correctly preserve all fields through conversion, including tool_use,
 * tool_result, thinking, and edge cases.
 *
 * Run:
 *   npm run build -w @dmoss/agent
 *   node packages/dmoss-agent/test/message-conversion-roundtrip.spec.mjs
 */

import assert from 'node:assert/strict';
import {
  toSessionMessages,
  fromSessionMessages,
  toLLMMessages,
} from '../dist/core/agent/dmoss-agent-types.js';

// ── Test 1: Simple text round-trip ──
{
  const internal = [
    { role: 'user', content: 'hello', timestamp: 1000 },
    { role: 'assistant', content: 'hi there', timestamp: 2000 },
  ];

  const session = toSessionMessages(internal);
  assert.equal(session.length, 2);
  assert.equal(session[0].role, 'user');
  assert.equal(session[0].content, 'hello');
  assert.equal(session[1].role, 'assistant');
  assert.equal(session[1].content, 'hi there');

  const back = fromSessionMessages(session);
  assert.equal(back.length, 2);
  assert.equal(back[0].content, 'hello');
  assert.equal(back[1].content, 'hi there');

  console.log('[PASS] Simple text round-trip');
}

// ── Test 2: Tool use + tool result round-trip ──
{
  const internal = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/index.ts' } },
      ],
      timestamp: 1000,
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents here', is_error: false },
      ],
      timestamp: 2000,
    },
  ];

  const session = toSessionMessages(internal);
  assert.equal(session.length, 2);
  assert.equal(session[0].content.length, 2);
  assert.equal(session[0].content[0].type, 'text');
  assert.equal(session[0].content[1].type, 'tool_use');
  assert.equal(session[0].content[1].id, 'call_1');
  assert.equal(session[0].content[1].name, 'read_file');
  assert.deepEqual(session[0].content[1].input, { path: 'src/index.ts' });
  assert.equal(session[1].content[0].type, 'tool_result');
  assert.equal(session[1].content[0].tool_use_id, 'call_1');
  assert.equal(session[1].content[0].content, 'file contents here');

  const back = fromSessionMessages(session);
  assert.equal(back[0].content[1].type, 'tool_use');
  assert.equal(back[0].content[1].id, 'call_1');
  assert.deepEqual(back[0].content[1].input, { path: 'src/index.ts' });
  assert.equal(back[1].content[0].type, 'tool_result');
  assert.equal(back[1].content[0].tool_use_id, 'call_1');

  console.log('[PASS] Tool use + tool result round-trip');
}

// ── Test 3: Thinking preservation ──
{
  const internal = [
    {
      role: 'assistant',
      content: 'answer',
      timestamp: 1000,
      thinking: ['I need to think about this', 'step by step'],
    },
  ];

  const session = toSessionMessages(internal);
  assert.deepEqual(session[0].thinking, ['I need to think about this', 'step by step']);

  const back = fromSessionMessages(session);
  assert.deepEqual(back[0].thinking, ['I need to think about this', 'step by step']);

  console.log('[PASS] Thinking preservation');
}

// ── Test 4: toLLMMessages conversion ──
{
  const internal = [
    { role: 'user', content: 'hello', timestamp: 1000 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that.' },
        { type: 'tool_use', id: 'call_2', name: 'exec', input: { command: 'ls' } },
      ],
      timestamp: 2000,
      thinking: ['planning'],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_2', content: 'file1\nfile2', is_error: false },
      ],
      timestamp: 3000,
    },
  ];

  const llm = toLLMMessages(internal);
  assert.equal(llm.length, 3);

  assert.equal(llm[0].role, 'user');
  assert.equal(llm[0].content, 'hello');

  assert.equal(llm[1].role, 'assistant');
  assert.equal(llm[1].content.length, 2);
  assert.equal(llm[1].content[0].type, 'text');
  assert.equal(llm[1].content[0].text, 'Let me read that.');
  assert.equal(llm[1].content[1].type, 'tool_use');
  assert.equal(llm[1].content[1].id, 'call_2');
  assert.equal(llm[1].content[1].name, 'exec');
  assert.deepEqual(llm[1].content[1].input, { command: 'ls' });
  assert.deepEqual(llm[1].thinking, ['planning']);

  assert.equal(llm[2].role, 'user');
  assert.equal(llm[2].content[0].type, 'tool_result');
  assert.equal(llm[2].content[0].tool_use_id, 'call_2');
  assert.equal(llm[2].content[0].content, 'file1\nfile2');
  assert.equal(llm[2].content[0].is_error, false);

  console.log('[PASS] toLLMMessages conversion');
}

// ── Test 5: Error tool result ──
{
  const internal = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_3', content: 'permission denied', is_error: true },
      ],
      timestamp: 1000,
    },
  ];

  const session = toSessionMessages(internal);
  assert.equal(session[0].content[0].is_error, true);
  assert.equal(session[0].content[0].content, 'permission denied');

  const back = fromSessionMessages(session);
  assert.equal(back[0].content[0].is_error, true);

  const llm = toLLMMessages(internal);
  assert.equal(llm[0].content[0].is_error, true);

  console.log('[PASS] Error tool result');
}

// ── Test 6: Empty content blocks ──
{
  const internal = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'call_4', name: 'noop', input: {} },
      ],
      timestamp: 1000,
    },
  ];

  const session = toSessionMessages(internal);
  assert.equal(session[0].content[0].text, '');
  assert.deepEqual(session[0].content[1].input, {});

  const back = fromSessionMessages(session);
  assert.equal(back[0].content[0].text, '');
  assert.deepEqual(back[0].content[1].input, {});

  console.log('[PASS] Empty content blocks');
}

// ── Test 7: Multi-turn conversation ──
{
  const internal = [
    { role: 'user', content: 'step 1', timestamp: 1000 },
    { role: 'assistant', content: 'doing step 1', timestamp: 2000 },
    { role: 'user', content: 'step 2', timestamp: 3000 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'running tool' },
        { type: 'tool_use', id: 't1', name: 'exec', input: { command: 'echo hi' } },
      ],
      timestamp: 4000,
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false },
      ],
      timestamp: 5000,
    },
    { role: 'assistant', content: 'done', timestamp: 6000 },
  ];

  const session = toSessionMessages(internal);
  assert.equal(session.length, 6);

  const back = fromSessionMessages(session);
  assert.equal(back.length, 6);
  assert.equal(back[0].content, 'step 1');
  assert.equal(back[5].content, 'done');

  const llm = toLLMMessages(internal);
  assert.equal(llm.length, 6);
  assert.equal(llm[3].content[1].type, 'tool_use');
  assert.equal(llm[4].content[0].type, 'tool_result');

  console.log('[PASS] Multi-turn conversation');
}

// ── Test 8: Structured tool result content survives session reload ──
{
  const structuredContent = [
    { type: 'text', text: 'structured detail for model follow-up' },
    { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png', alt: 'fake image' },
    { type: 'resource', uri: 'file:///tmp/result.txt', name: 'result.txt', mimeType: 'text/plain' },
  ];
  const internal = [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-rich',
          content: 'plain fallback',
          is_error: false,
          structuredContent,
        },
      ],
      timestamp: 1000,
    },
  ];

  const session = toSessionMessages(internal);
  assert.deepEqual(session[0].content[0].structuredContent, structuredContent);

  const back = fromSessionMessages(session);
  assert.deepEqual(back[0].content[0].structuredContent, structuredContent);

  const llm = toLLMMessages(back);
  assert.deepEqual(llm[0].content[0].structuredContent, structuredContent);

  console.log('[PASS] Structured tool result content round-trip');
}

console.log('\n[pass] message-conversion-roundtrip: 8/8');
