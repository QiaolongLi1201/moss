#!/usr/bin/env node
/**
 * Self-test for DmossAgent tool-loop guard.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/dmoss-agent/test/tool-loop-guard.spec.mjs
 *
 * The test uses a fake LLM provider and in-memory tools so it does not touch
 * real models, devices, network, or user data.
 */

import assert from 'node:assert/strict';
import {
  DmossAgent,
  InMemorySessionStore,
  SteeringEngine,
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_TOOL_LOOP_RULE,
} from '../dist/core/index.js';
import {
  createToolLoopGuardState,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
} from '../dist/core/tools/tool-loop-guard.js';

const GUARD_MARKER = '[dmoss-agent] Tool loop guard stopped';

function withEnv(overrides, fn) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(overrides)) {
    previousEnv[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runHighVolumeLocalToolGuardTests() {
  withEnv({
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: undefined,
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: undefined,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: undefined,
    DMOSS_TOOL_LOOP_FAILURE_LIMIT: undefined,
  }, () => {
    const state = createToolLoopGuardState();
    for (let i = 0; i < 80; i += 1) {
      assert.equal(
        shouldShortCircuitToolCall(state, 'preset_probe', { value: `distinct-${i}` }),
        null,
        'unset tool-loop env should not create an implicit by-tool or total-count guard',
      );
    }
    for (let i = 0; i < 8; i += 1) {
      assert.equal(
        shouldShortCircuitToolCall(state, 'preset_probe', { value: 'same' }),
        null,
        'unset tool-loop env should not create an implicit identical-input guard',
      );
    }
    for (let i = 0; i < 8; i += 1) {
      recordToolLoopOutcome(state, 'web_fetch', true);
      assert.equal(
        shouldShortCircuitToolCall(state, 'web_fetch', { value: `failed-${i}` }),
        null,
        'unset tool-loop env should not create an implicit repeated-failure guard',
      );
    }
  });

  withEnv({
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 99,
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: 3,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: undefined,
  }, () => {
    const state = createToolLoopGuardState();
    for (let i = 0; i < 80; i += 1) {
      const reason = shouldShortCircuitToolCall(state, 'edit_file', {
        path: `src/file-${i}.ts`,
        old_string: `before ${i}`,
        new_string: `after ${i}`,
      });
      assert.equal(reason, null, 'distinct edit_file calls should not hit implicit single-tool or total-count guards');
    }
  });

  withEnv({
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 99,
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: 3,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: 4,
  }, () => {
    const state = createToolLoopGuardState();
    for (let i = 0; i < 4; i += 1) {
      assert.equal(shouldShortCircuitToolCall(state, 'edit_file', { path: `src/${i}.ts` }), null);
    }
    assert.match(
      shouldShortCircuitToolCall(state, 'edit_file', { path: 'src/4.ts' }) ?? '',
      /user turn already requested 4 tool call/,
      'the total tool budget should still catch runaway high-volume local work',
    );
  });

  console.log('  [PASS] high-volume local file tools bypass implicit count guards while honoring explicit budgets');
}

function makeTool(name, calls) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    async execute(input) {
      calls.push({ name, input });
      return `${name}:ok:${JSON.stringify(input)}`;
    },
  };
}

function makeFailingTool(name, calls) {
  return {
    name,
    description: `${name} failing test tool`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    async execute(input) {
      calls.push({ name, input });
      throw new Error(`${name} simulated failure`);
    },
  };
}

function makeSoftFailingTool(name, calls) {
  return {
    name,
    description: `${name} soft-failing test tool`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    },
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    async execute(input) {
      calls.push({ name, input });
      // Soft failure: returns an error-marker string WITHOUT throwing (is_error stays
      // false) — exactly how web_fetch reports a 404. The guard must still count it.
      return `web_fetch_error: HTTP 404 Not Found — ${JSON.stringify(input)}`;
    },
  };
}

function lastToolResultText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    const block = msg.content.find((b) => b.type === 'tool_result');
    if (block) return String(block.content ?? '');
  }
  return '';
}

class ScriptedProvider {
  constructor(toolUses) {
    this.id = 'scripted';
    this.displayName = 'Scripted Provider';
    this.toolUses = toolUses;
    this.index = 0;
    this.requests = [];
  }

  async complete(options) {
    this.requests.push(options);
    const previousToolResult = lastToolResultText(options.messages);
    if (previousToolResult.includes(GUARD_MARKER)) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'saw guard and pivoted' }],
      };
    }
    const next = this.toolUses[this.index++];
    if (!next) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      };
    }
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `tool_${this.index}`, ...next }],
    };
  }

  async stream(options, onEvent) {
    const response = await this.complete(options);
    for (const block of response.content) {
      if (block.type === 'text') {
        onEvent({ type: 'content_block_delta', text: block.text, deltaRole: 'visible' });
      }
    }
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    return response;
  }
}

async function runChatScenario(name, toolUses, env, assertFn) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    const provider = new ScriptedProvider(toolUses);
    const store = new InMemorySessionStore();
    const calls = [];
    const agent = new DmossAgent({
      llmProvider: provider,
      sessionStore: store,
      domainPrompt: false,
      enableContextPruning: false,
      enableCompaction: false,
      maxAgentTurns: 16,
    });
    agent.tools.register(makeTool('preset_probe', calls));
    agent.tools.register(makeTool('web_search', calls));
    agent.tools.register(makeTool('device_exec', calls));

    const result = await agent.chat(`test-${name}`, 'start');
    const messages = await store.loadMessages(`test-${name}`);
    assertFn({ provider, calls, result, messages });
    console.log(`  [PASS] ${name}`);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runStreamScenario() {
  const oldIdentical = process.env.DMOSS_TOOL_LOOP_IDENTICAL_LIMIT;
  process.env.DMOSS_TOOL_LOOP_IDENTICAL_LIMIT = '2';
  try {
    const provider = new ScriptedProvider([
      { name: 'preset_probe', input: { value: 'same' } },
      { name: 'preset_probe', input: { value: 'same' } },
      { name: 'preset_probe', input: { value: 'same' } },
    ]);
    const store = new InMemorySessionStore();
    const calls = [];
    const agent = new DmossAgent({
      llmProvider: provider,
      sessionStore: store,
      domainPrompt: false,
      enableContextPruning: false,
      enableCompaction: false,
      maxAgentTurns: 16,
    });
    agent.tools.register(makeTool('preset_probe', calls));

    const events = [];
    for await (const event of agent.streamChat('test-stream', 'start')) {
      events.push(event);
    }

    const toolEnds = events.filter((e) => e.type === 'tool_end');
    assert.equal(calls.length, 1, 'stream path should execute only the first identical non-mutating call; second is replayed');
    assert.equal(toolEnds.length, 3, 'stream path should still surface all three tool_end events');
    assert.ok(toolEnds[2].result.includes(GUARD_MARKER), 'third stream tool result should be guard text');
    assert.ok(toolEnds[2].result.includes('web_fetch'), 'guard text should tell the model to pivot to independent evidence');
    console.log('  [PASS] streamChat identical-repeat guard mirrors chat');
  } finally {
    if (oldIdentical === undefined) delete process.env.DMOSS_TOOL_LOOP_IDENTICAL_LIMIT;
    else process.env.DMOSS_TOOL_LOOP_IDENTICAL_LIMIT = oldIdentical;
  }
}

function runSteeringTests() {
  const errorEngine = new SteeringEngine([BUILTIN_ERROR_RECOVERY_RULE]);
  const errorGuidance = errorEngine.evaluate({
    messages: [],
    turn: 3,
    consecutiveToolErrors: 3,
    totalToolCalls: 3,
    contextUsageRatio: 0,
    sessionKey: 'test',
  });
  assert.equal(errorGuidance.firedRules[0], 'error-recovery');
  assert.ok(errorGuidance.guidances.join('\n').includes('web_fetch'));
  assert.ok(errorGuidance.guidances.join('\n').includes('lower-level device commands'));

  const loopEngine = new SteeringEngine([BUILTIN_TOOL_LOOP_RULE]);
  const loopGuidance = loopEngine.evaluate({
    messages: Array.from({ length: 4 }, (_, i) => ({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'preset_probe', input: {} }],
    })),
    turn: 8,
    consecutiveToolErrors: 0,
    totalToolCalls: 8,
    contextUsageRatio: 0,
    sessionKey: 'test',
  });
  assert.equal(loopGuidance.firedRules[0], 'tool-loop');
  assert.ok(loopGuidance.guidances.join('\n').includes('switch to a different source of evidence'));
  console.log('  [PASS] steering nudges explicitly require fallback evidence');
}

await runChatScenario(
  'identical input short-circuits on third request',
  [
    { name: 'preset_probe', input: { value: 'same' } },
    { name: 'preset_probe', input: { value: 'same' } },
    { name: 'preset_probe', input: { value: 'same' } },
  ],
  { DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 2 },
  ({ calls, result, messages }) => {
    assert.equal(calls.length, 1, 'second identical non-mutating call should replay, not execute');
    assert.equal(result.response, 'saw guard and pivoted');
    assert.ok(lastToolResultText(messages).includes(GUARD_MARKER));
    assert.ok(lastToolResultText(messages).includes('web_fetch'));
  },
);

await runChatScenario(
  'single tool budget short-circuits distinct inputs',
  [
    { name: 'preset_probe', input: { value: '0' } },
    { name: 'preset_probe', input: { value: '1' } },
    { name: 'preset_probe', input: { value: '2' } },
    { name: 'preset_probe', input: { value: '3' } },
  ],
  {
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 99,
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: 3,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: 99,
  },
  ({ calls, messages }) => {
    assert.equal(calls.length, 3);
    assert.ok(lastToolResultText(messages).includes('preset_probe has already been requested 3 time(s)'));
  },
);

await runChatScenario(
  'total tool budget catches cross-tool churn',
  [
    { name: 'preset_probe', input: { value: '0' } },
    { name: 'web_search', input: { value: '1' } },
    { name: 'device_exec', input: { value: '2' } },
    { name: 'preset_probe', input: { value: '3' } },
    { name: 'web_search', input: { value: '4' } },
  ],
  {
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 99,
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: 99,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: 4,
  },
  ({ calls, messages }) => {
    assert.equal(calls.length, 4);
    assert.ok(lastToolResultText(messages).includes('user turn already requested 4 tool call(s)'));
  },
);

await runChatScenario(
  'invalid env values do not create hidden default limits',
  [
    { name: 'preset_probe', input: { value: 'same' } },
    { name: 'preset_probe', input: { value: 'same' } },
    { name: 'preset_probe', input: { value: 'same' } },
  ],
  {
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: 'not-a-number',
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: undefined,
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: undefined,
    DMOSS_TOOL_LOOP_FAILURE_LIMIT: undefined,
  },
  ({ calls, result, messages }) => {
    assert.equal(calls.length, 1, 'idempotent replay may reuse the result, but the hidden guard must stay off');
    assert.equal(result.response, 'done');
    assert.ok(!lastToolResultText(messages).includes(GUARD_MARKER));
  },
);

async function runFailureLoopScenario() {
  const env = {
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: '99',
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: '99',
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: '99',
    DMOSS_TOOL_LOOP_FAILURE_LIMIT: '3',
  };
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    // Same tool, DISTINCT inputs (so only the failure counter can trip), all erroring.
    const provider = new ScriptedProvider([
      { name: 'web_fetch', input: { value: 'u0' } },
      { name: 'web_fetch', input: { value: 'u1' } },
      { name: 'web_fetch', input: { value: 'u2' } },
      { name: 'web_fetch', input: { value: 'u3' } },
    ]);
    const store = new InMemorySessionStore();
    const calls = [];
    const agent = new DmossAgent({
      llmProvider: provider,
      sessionStore: store,
      domainPrompt: false,
      enableContextPruning: false,
      enableCompaction: false,
      maxAgentTurns: 16,
    });
    agent.tools.register(makeFailingTool('web_fetch', calls));

    await agent.chat('test-failloop', 'start');
    const messages = await store.loadMessages('test-failloop');
    assert.equal(calls.length, 3, 'a tool that keeps failing should execute up to the failure limit (3), then short-circuit');
    const last = lastToolResultText(messages);
    assert.ok(last.includes('web_fetch has failed 3 time(s)'), 'guard should cite repeated failures, not the by-name budget');
    assert.ok(/STOP calling it/.test(last), 'failure guard must tell the model to stop calling the broken tool');
    assert.ok(/Never invent|could not retrieve/i.test(last), 'failure guard must forbid inventing the content it could not fetch');
    console.log('  [PASS] repeated tool failures trip the failure guard with a stop-and-be-honest message');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function runSoftFailureLoopScenario() {
  const env = {
    DMOSS_TOOL_LOOP_IDENTICAL_LIMIT: '99',
    DMOSS_TOOL_LOOP_SINGLE_TOOL_LIMIT: '99',
    DMOSS_TOOL_LOOP_TOTAL_LIMIT: '99',
    DMOSS_TOOL_LOOP_FAILURE_LIMIT: '3',
  };
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try {
    const provider = new ScriptedProvider([
      { name: 'web_fetch', input: { value: 'u0' } },
      { name: 'web_fetch', input: { value: 'u1' } },
      { name: 'web_fetch', input: { value: 'u2' } },
      { name: 'web_fetch', input: { value: 'u3' } },
    ]);
    const store = new InMemorySessionStore();
    const calls = [];
    const agent = new DmossAgent({
      llmProvider: provider,
      sessionStore: store,
      domainPrompt: false,
      enableContextPruning: false,
      enableCompaction: false,
      maxAgentTurns: 16,
    });
    agent.tools.register(makeSoftFailingTool('web_fetch', calls));

    await agent.chat('test-softfailloop', 'start');
    const messages = await store.loadMessages('test-softfailloop');
    assert.equal(calls.length, 3, 'soft failures (web_fetch_error 404, is_error=false) must still count toward the failure limit');
    const last = lastToolResultText(messages);
    assert.ok(last.includes('web_fetch has failed 3 time(s)'), 'soft 404 failures should trip the failure guard');
    console.log('  [PASS] soft failures (error text in a non-error result) trip the failure guard');
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function runMaxToolCallsScenario() {
  const provider = new ScriptedProvider([
    { name: 'read_file', input: { value: 'one' } },
    { name: 'read_file', input: { value: 'two' } },
  ]);
  const store = new InMemorySessionStore();
  const calls = [];
  const agent = new DmossAgent({
    llmProvider: provider,
    sessionStore: store,
    domainPrompt: false,
    enableContextPruning: false,
    enableCompaction: false,
    maxAgentTurns: 8,
  });
  agent.tools.register(makeTool('read_file', calls));

  for await (const _event of agent.streamChat('test-max-tool-calls', 'start', {
    maxToolCalls: 1,
    maxTurns: 4,
  })) {
    // drain
  }
  const messages = await store.loadMessages('test-max-tool-calls');
  assert.equal(calls.length, 1, 'per-call maxToolCalls should prevent the second tool from executing');
  assert.match(lastToolResultText(messages), /Tool budget reached \(1\)/, 'the skipped tool result should tell the model to answer with gathered evidence');
  console.log('  [PASS] per-call maxToolCalls blocks further tool execution after the budget');
}

await runStreamScenario();
await runFailureLoopScenario();
await runSoftFailureLoopScenario();
await runMaxToolCallsScenario();
runSteeringTests();
runHighVolumeLocalToolGuardTests();

console.log('\n[pass] tool-loop-guard self-test: 10/10');
