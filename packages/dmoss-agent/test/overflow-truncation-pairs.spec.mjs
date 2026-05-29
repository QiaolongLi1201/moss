#!/usr/bin/env node
/**
 * Tests for findSafeTruncationPoint — ensures emergency truncation
 * does not split tool_use/tool_result pairs.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/overflow-truncation-pairs.spec.mjs
 */

import assert from 'node:assert/strict';
import { findSafeTruncationPoint } from '../dist/core/loop/overflow-recovery.js';

function makeAssistantWithToolUse(id, name) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
    timestamp: Date.now(),
  };
}

function makeUserWithToolResult(toolUseId, content) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: content || 'ok' }],
    timestamp: Date.now(),
  };
}

function makeTextMessage(role, text) {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

// ── Test 1: No tool_use in suffix → no adjustment ──
{
  const msgs = [
    makeTextMessage('user', 'hello'),
    makeTextMessage('assistant', 'hi'),
    makeTextMessage('user', 'how are you'),
    makeTextMessage('assistant', 'good'),
    makeTextMessage('user', 'bye'),
    makeTextMessage('assistant', 'goodbye'),
    makeTextMessage('user', 'really bye'),
  ];
  const cut = findSafeTruncationPoint(msgs, 3);
  assert.equal(cut, 4, 'no tool pairs → cut at messages.length - targetKeep');
}

// ── Test 2: tool_use in suffix, tool_result in prefix → adjust forward ──
{
  const msgs = [
    makeTextMessage('user', 'do something'),
    makeAssistantWithToolUse('tu1', 'read_file'),
    makeUserWithToolResult('tu1', 'file contents'),
    makeTextMessage('assistant', 'I read the file'),
    makeTextMessage('user', 'now do more'),
    makeTextMessage('assistant', 'doing more'),
  ];
  // targetKeep=3 means cut at index 3, keeping msgs[3..5]
  // msg[1] has tool_use 'tu1', msg[2] has tool_result 'tu1'
  // cut at 3 means suffix has msgs[3,4,5] — no tool_use in suffix, no adjustment needed
  const cut = findSafeTruncationPoint(msgs, 3);
  assert.equal(cut, 3);
}

// ── Test 3: tool_use in suffix, its tool_result would be dropped ──
{
  const msgs = [
    makeTextMessage('user', 'do something'),
    makeTextMessage('assistant', 'ok'),
    makeTextMessage('user', 'more'),
    makeAssistantWithToolUse('tu1', 'read_file'),  // index 3 — in suffix
    makeUserWithToolResult('tu1', 'file contents'), // index 4 — in suffix
    makeTextMessage('assistant', 'done'),           // index 5
    makeTextMessage('user', 'next'),                // index 6
  ];
  // targetKeep=3 → initial cut at 4, keeping msgs[4..6]
  // msg[3] (tool_use tu1) is in DROPPED prefix, msg[4] (tool_result tu1) is in KEPT suffix
  // Reverse scan detects the orphan tool_result in suffix and moves cut to include tool_use.
  const cut = findSafeTruncationPoint(msgs, 3);
  // Reverse scan moves cut from 4 to 3 to include the matching tool_use
  assert.equal(cut, 3);
}

// ── Test 4: THE CRITICAL CASE — tool_use in kept suffix, tool_result in dropped prefix ──
{
  const msgs = [
    makeTextMessage('user', 'start'),               // 0
    makeTextMessage('assistant', 'ok'),              // 1
    makeAssistantWithToolUse('tu1', 'exec'),         // 2 — WILL be in suffix
    makeUserWithToolResult('tu1', 'exec output'),   // 3 — would be DROPPED at cut=3
    makeTextMessage('assistant', 'result noted'),    // 4
    makeTextMessage('user', 'continue'),             // 5
  ];
  // targetKeep=3 → initial cut at 3, keeping msgs[3..5]
  // msg[2] has tool_use 'tu1' — in the DROPPED prefix
  // msg[3] has tool_result 'tu1' — in the KEPT suffix
  // Reverse scan detects orphan tool_result and moves cut to include tool_use.
  const cut = findSafeTruncationPoint(msgs, 3);
  assert.equal(cut, 2, 'reverse scan moves cut to include tool_use for orphan tool_result');
}

// ── Test 5: The actual dangerous case — tool_use in suffix, result in prefix ──
{
  const msgs = [
    makeTextMessage('user', 'start'),               // 0 — dropped
    makeTextMessage('assistant', 'ok'),              // 1 — dropped
    makeTextMessage('user', 'do it'),                // 2 — dropped (but has tool_result for tu1!)
    makeAssistantWithToolUse('tu1', 'exec'),         // 3 — KEPT (has tool_use)
    makeTextMessage('assistant', 'also this'),       // 4 — kept
    makeTextMessage('user', 'next'),                 // 5 — kept
  ];
  // Wait, this doesn't make sense structurally. tool_result comes AFTER tool_use.
  // The real dangerous case is:
  // assistant: [tool_use tu1]  → in KEPT suffix
  // user: [tool_result tu1]   → in DROPPED prefix
  // This can't happen because tool_result always follows tool_use in message order.
  // So the cut would have to be BETWEEN them:
  {
    const msgs2 = [
      makeTextMessage('user', 'start'),             // 0
      makeAssistantWithToolUse('tu1', 'exec'),       // 1 — KEPT
      makeUserWithToolResult('tu1', 'result'),       // 2 — DROPPED!
      makeTextMessage('assistant', 'done'),          // 3 — KEPT
      makeTextMessage('user', 'more'),               // 4 — KEPT
    ];
    // targetKeep=3 → initial cut at 2, keeping msgs[2..4]
    // msg[1] has tool_use 'tu1' in DROPPED prefix
    // msg[2] has tool_result 'tu1' in KEPT suffix — orphan detected by reverse scan
    const cut2 = findSafeTruncationPoint(msgs2, 3);
    // Reverse scan moves cut from 2 to 1 to include tool_use
    assert.equal(cut2, 1);
  }
}

// ── Test 6: ACTUAL dangerous case — tool_use in KEPT, result would be dropped ──
{
  const msgs = [
    makeTextMessage('user', 'a'),                   // 0 — dropped
    makeTextMessage('assistant', 'b'),               // 1 — dropped
    makeAssistantWithToolUse('tu1', 'exec'),         // 2 — KEPT (tool_use here)
    makeUserWithToolResult('tu1', 'output'),         // 3 — DROPPED by naive cut!
    makeTextMessage('assistant', 'd'),               // 4 — KEPT
    makeTextMessage('user', 'e'),                    // 5 — KEPT
    makeTextMessage('assistant', 'f'),               // 6 — KEPT
  ];
  // targetKeep=4 → cut at 3, keeping msgs[3..6]
  // msg[2] has tool_use 'tu1' — in DROPPED prefix, not suffix. So no danger.
  // targetKeep=5 → cut at 2, keeping msgs[2..6]
  // msg[2] has tool_use 'tu1' — KEPT in suffix
  // msg[3] has tool_result 'tu1' — also KEPT in suffix (index 3 >= cut 2). Fine.

  // Now the REAL dangerous case:
  // We want: tool_use in KEPT suffix, tool_result in DROPPED prefix
  // This means the cut is BETWEEN tool_use and tool_result
  // targetKeep=4 with 7 messages → cut at 3
  // suffix = msgs[3,4,5,6]. If msg[3] is tool_use and msg[4] is tool_result — both in suffix, fine.
  // For the cut to split them, tool_use must be at index >= cut, tool_result at index < cut.
  // But tool_result always FOLLOWS tool_use! So tool_result index > tool_use index.
  // If tool_use is in suffix (index >= cut), then tool_result index > tool_use index >= cut,
  // so tool_result is also in suffix. THEY CAN'T BE SPLIT THIS WAY.

  // Wait... I was confused. Let me reconsider.
  // tool_use is in an ASSISTANT message. tool_result is in the NEXT USER message.
  // So tool_use is at index N (assistant), tool_result is at index N+1 (user).
  // If cut = N+1, then tool_use (index N) is DROPPED and tool_result (index N+1) is KEPT.
  // This creates an orphan tool_result — handled by roundtrip guard.
  // If cut = N, then tool_use (index N) is KEPT and tool_result (index N+1) is also KEPT (N+1 >= N).
  // If cut = N+2, both are dropped.

  // So the split where tool_use is KEPT but tool_result is DROPPED requires:
  // cut > N (tool_use is kept, i.e., index N >= cut is false... wait, KEPT means index >= cut)
  // tool_use kept: N >= cut
  // tool_result dropped: N+1 < cut → cut > N+1
  // But N >= cut AND cut > N+1 is impossible (N >= cut > N+1 means N > N+1, contradiction).

  // CONCLUSION: In a normal conversation flow where tool_result follows tool_use,
  // a simple slice(-N) CANNOT produce a dangling tool_use (tool_use kept, result dropped).
  // It CAN produce an orphan tool_result (result kept, tool_use dropped) — which the
  // roundtrip guard handles by synthesizing a fake tool_use.

  // However, there IS a real case: when MULTIPLE tool_use blocks are in one assistant message,
  // and the user message contains tool_results for SOME but not all. But that's within a single
  // user message and can't be split by slice.

  // The real value of findSafeTruncationPoint is for the REVERSE case:
  // ensuring we don't create orphan tool_results by including them without their tool_use.
  // targetKeep=4 with 7 messages → initial cut at 3, keeping msgs[3..6]
  // msg[2] has tool_use 'tu1' in prefix, msg[3] has tool_result 'tu1' in suffix
  // Reverse scan detects orphan tool_result and moves cut from 3 to 2.
  const cut = findSafeTruncationPoint(msgs, 4);
  assert.equal(cut, 2, 'reverse scan moves cut to include tool_use for orphan tool_result');
}

// ── Test 7: Orphan tool_result protection — result kept, tool_use dropped ──
{
  const msgs = [
    makeTextMessage('user', 'start'),               // 0
    makeAssistantWithToolUse('tu1', 'exec'),         // 1
    makeUserWithToolResult('tu1', 'result'),         // 2
    makeTextMessage('assistant', 'noted'),           // 3
    makeTextMessage('user', 'next'),                 // 4
  ];
  // targetKeep=3 → initial cut at 2, keeping msgs[2..4]
  // msg[1] (tool_use tu1) dropped, msg[2] (tool_result tu1) kept → orphan tool_result
  // Reverse scan detects orphan tool_result and moves cut from 2 to 1.
  const cut = findSafeTruncationPoint(msgs, 3);
  assert.equal(cut, 1, 'reverse scan moves cut to include tool_use for orphan tool_result');
}

// ── Test 8: Empty messages ──
{
  const cut = findSafeTruncationPoint([], 3);
  assert.equal(cut, 0);
}

// ── Test 9: targetKeep >= length ──
{
  const msgs = [makeTextMessage('user', 'hi')];
  const cut = findSafeTruncationPoint(msgs, 5);
  assert.equal(cut, 0);
}

// ── Test 10: targetKeep = 0 ──
{
  const msgs = [makeTextMessage('user', 'hi'), makeTextMessage('assistant', 'hello')];
  const cut = findSafeTruncationPoint(msgs, 0);
  assert.equal(cut, 2); // all messages dropped
}

console.log('All overflow-truncation-pairs tests passed ✓');
