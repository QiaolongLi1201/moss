#!/usr/bin/env node
/**
 * Pure-node self-test for `classifyProviderError` — specifically the
 * `quota_exceeded` / `rate_limit` split introduced by
 * `2026-04-24-provider-quota-distinct-surface`.
 *
 * We cannot directly `import` the TS source here (no compile step in verify
 * for pure-node specs), so we replicate the relevant matcher logic **verbatim**
 * (copy-read) from `packages/dmoss-agent/src/provider/error-classify.ts`.
 * If the replicated copy drifts from host impl, `typecheck` will not catch it;
 * the only guard is reviewer's byte-read of both files during the hotfix flow.
 *
 * Run: `node packages/dmoss-agent/test/error-classify.spec.mjs`
 * Exit 0 on pass; exit 1 on any assertion failure.
 */

import assert from 'node:assert/strict';

/* ---- Replicated matcher logic (must stay byte-equal to host impl) ---- */

function matchAuth(msg, status) {
  if (status === 401) return true;
  const m = msg.toLowerCase();
  return /incorrect api key|invalid api key|unauthorized|api key/i.test(m);
}

function matchAbort(msg) {
  const m = msg.toLowerCase();
  return m.includes('request was aborted') || m.includes('aborterror') || m === 'aborted';
}

function matchContextCorruption(msg) {
  const m = msg.toLowerCase();
  if (m.includes('reasoning_content') && m.includes('thinking mode')) {
    return { hit: true, flavor: 'thinking' };
  }
  if (m.includes('tool result') && m.includes('not found')) {
    return { hit: true, flavor: 'tool' };
  }
  if (/\(2013\)/.test(m)) {
    return { hit: true, flavor: 'tool' };
  }
  return { hit: false, flavor: null };
}

function matchQuotaExceeded(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    /exceeded (?:the |your )?(?:monthly |daily |current )?(?:usage )?quota/.test(m) ||
    /monthly usage (?:quota|limit)/.test(m) ||
    /usage limit (?:exceeded|reached)/.test(m) ||
    /plan (?:quota|limit)/.test(m) ||
    /insufficient_quota/.test(m) ||
    /out of credits/.test(m)
  );
}

function matchRateLimit(msg, status) {
  if (status === 429) return true;
  const m = msg.toLowerCase();
  return /rate[ _-]?limit|quota|too many requests|limit exceeded/i.test(m);
}

function matchOpaqueStreamConnectionDrop(msg) {
  const m = msg.toLowerCase().trim();
  return (
    m === 'terminated' ||
    m === 'connection error' ||
    m === 'connection error.' ||
    /^(?:llm\s+stream\s+error:\s*)?terminated\.?$/i.test(msg.trim()) ||
    /^(?:llm\s+stream\s+error:\s*)?connection error\.?$/i.test(msg.trim()) ||
    /terminated.*other side closed|other side closed|stream.*terminated/i.test(m)
  );
}

function matchRuntimeLifecycle(msg) {
  const m = msg.toLowerCase();
  return (
    /lifecyle_error|lifecycle_error|requested agent harness|agent harness .*not registered|protocol mismatch|agent session failed|occode/i.test(
      msg,
    ) ||
    /anthropic messages transport requires a positive maxtokens value|requires a positive maxTokens value/i.test(
      msg,
    ) ||
    (m.includes('board agent') && /gateway|protocol|lifecycle|harness|not registered|maxtokens/.test(m))
  );
}

function matchContextLengthExceeded(msg, code) {
  if ((code ?? '').toLowerCase() === 'context_length_exceeded') return true;
  const c = (code ?? '').toLowerCase();
  if (
    (c === 'invalid_request_error' || c === 'bad_request') &&
    /context|token|length|窗口|超限|过长/i.test(msg)
  ) {
    return true;
  }
  const raw = msg.trim();
  if (
    /上下文\s*(?:长度|窗口)?\s*(?:超限|超过|溢出)|(?:超过|超出)\s*(?:最大)?\s*上下文|prompt\s*过长|输入\s*(?:过长|超限)|(?:消息|文本).*过长|token\s*(?:超限|不足|溢出)|(?:超过|超出).*?\btokens?\b/i.test(
      raw,
    )
  ) {
    return true;
  }
  const m = msg.toLowerCase();
  return /context_length_exceeded|maximum context (?:length|tokens)|max(?:imum)?_tokens|context window(?: exceeded)?|token\s*(?:limit|count).*exceed|exceeds?.*(?:model\s*)?(?:max(?:imum)?|allowed).*tokens|exceeds.*context|prompt is too long|too many tokens|total.*?tokens.*?high|input.*?too long|maximum input length|input length.*exceeds.*maximum|exceeds.*maximum.*(?:input|length|tokens)|requested.*?tokens/i.test(
    m,
  );
}

function matchServiceUnavailable(msg, status) {
  if (status === 502 || status === 503) return true;
  const m = msg.toLowerCase();
  return /service unavailable|temporarily unavailable|upstream (?:server|gateway) (?:error|busy)|gateway timeout|bad gateway|upstream connect error|model is currently overloaded|overloaded_error|server is busy|(?:llm\s+stream\s+error:\s*)?codex\s+stream\s+error/i.test(
    m,
  );
}

const ACTION_RETRY = { id: 'retry', label: '重试', variant: 'primary' };
const ACTION_OPEN_SETTINGS = {
  id: 'openSettings',
  label: '打开设置',
  variant: 'secondary',
};
const ACTION_OPEN_BOARD_AGENT = {
  id: 'openBoardAgent',
  label: '检查板端智能体',
  variant: 'primary',
};
const ACTION_SWITCH_MODEL = { id: 'switchModel', label: '换个模型', variant: 'ghost' };
const ACTION_NEW_SESSION = { id: 'newSession', label: '开新对话', variant: 'ghost' };

function classify(input) {
  const raw = String(input.errorMessage ?? '').trim();
  const status = input.status;

  if (matchAbort(raw)) {
    if (input.abortReason === 'user') {
      return {
        category: 'aborted_by_user',
        userMessage: '',
        actions: [],
        silent: true,
        retryable: false,
      };
    }
    return {
      category: 'aborted_by_server',
      userMessage: '请求被中断，请稍后重试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  if (matchAuth(raw, status)) {
    return {
      category: 'auth',
      userMessage: '模型访问密钥无效或配置异常，请在设置中校验。',
      actions: [ACTION_OPEN_SETTINGS, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: false,
    };
  }

  const ctx = matchContextCorruption(raw);
  if (ctx.hit) {
    if (ctx.flavor === 'thinking') {
      return {
        category: 'context_corruption',
        userMessage: '思考模式历史上下文缺少 reasoning 信息，建议开新对话或重试。',
        actions: [ACTION_NEW_SESSION, ACTION_RETRY],
        silent: false,
        retryable: false,
      };
    }
    return {
      category: 'context_corruption',
      userMessage: '工具调用上下文丢失，建议重新提问。',
      actions: [ACTION_RETRY, ACTION_NEW_SESSION],
      silent: false,
      retryable: false,
    };
  }

  if (matchQuotaExceeded(raw)) {
    return {
      category: 'quota_exceeded',
      userMessage: '当前模型的调用额度已用尽，建议换个模型或在设置中调整。',
      actions: [ACTION_SWITCH_MODEL, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: false,
    };
  }

  if (matchRateLimit(raw, status)) {
    return {
      category: 'rate_limit',
      userMessage: '访问太频繁，请稍后再试。',
      actions: [ACTION_RETRY],
      silent: false,
      retryable: true,
    };
  }

  if (matchContextLengthExceeded(raw, input.code)) {
    return {
      category: 'context_length_exceeded',
      userMessage:
        '本轮模型流式连接在长上下文处理后中断。建议开启新对话，让 Moss 先查看上一个会话内容再继续；也可以重试或换用更大上下文模型。',
      actions: [ACTION_NEW_SESSION, ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  if (matchServiceUnavailable(raw, status) || matchOpaqueStreamConnectionDrop(raw)) {
    return {
      category: 'service_unavailable',
      userMessage: '厂商服务暂时不可用，请稍后再试或切换深度/快速车道。',
      actions: [ACTION_RETRY, ACTION_SWITCH_MODEL],
      silent: false,
      retryable: true,
    };
  }

  if (matchRuntimeLifecycle(raw)) {
    return {
      category: 'runtime_lifecycle',
      userMessage:
        '板端协作运行时没有准备好，Moss 需要先恢复板端智能体或 Gateway 后才能继续。',
      actions: [ACTION_OPEN_BOARD_AGENT, ACTION_RETRY, ACTION_OPEN_SETTINGS],
      silent: false,
      retryable: true,
    };
  }

  return {
    category: 'unknown',
    userMessage:
      '模型暂时不可用。若当前对话反复失败，请开启新对话并让 Moss 查看上一个会话内容后继续。',
    actions: [ACTION_RETRY, ACTION_NEW_SESSION, ACTION_SWITCH_MODEL],
    silent: false,
    retryable: false,
  };
}

/* ---- Test 1: 429 + monthly quota exceeded message ---- */
/* This is the exact scenario reported by the user 2026-04-25:
 *   "429 You have exceeded the monthly usage quota. It will reset at ..."
 */
{
  const surface = classify({
    errorMessage:
      '429 You have exceeded the monthly usage quota. It will reset at 2026-04-25 23:59:59 +0800 CST.',
    status: 429,
  });
  assert.equal(surface.category, 'quota_exceeded', 'category must be quota_exceeded');
  assert.ok(
    surface.userMessage.includes('额度'),
    `userMessage should mention 额度, got: ${surface.userMessage}`,
  );
  const actionIds = surface.actions.map((a) => a.id);
  assert.ok(
    actionIds.includes('switchModel'),
    `actions should include switchModel, got: ${actionIds.join(',')}`,
  );
  assert.ok(
    !actionIds.includes('retry'),
    `quota_exceeded must NOT offer retry (pointless), got: ${actionIds.join(',')}`,
  );
  console.log('  [PASS] 429 monthly quota → quota_exceeded + 换个模型');
}

/* ---- Test 2: 429 without quota wording still falls into rate_limit ---- */
{
  const surface = classify({
    errorMessage: '429 rate limited, please retry after 5s',
    status: 429,
  });
  assert.equal(surface.category, 'rate_limit', 'plain rate-limit 429 stays rate_limit');
  assert.ok(
    surface.userMessage.includes('频繁'),
    `rate_limit userMessage should still say 频繁, got: ${surface.userMessage}`,
  );
  const actionIds = surface.actions.map((a) => a.id);
  assert.ok(actionIds.includes('retry'), 'rate_limit should still offer retry');
  console.log('  [PASS] 429 plain rate-limit → rate_limit + 重试');
}

/* ---- Test 3: 401 auth path is unaffected ---- */
{
  const surface = classify({
    errorMessage: 'Incorrect API key provided',
    status: 401,
  });
  assert.equal(surface.category, 'auth', '401 still → auth');
  console.log('  [PASS] 401 auth branch unchanged');
}

/* ---- Test 3b: reasoning_content thinking-mode error explains missing reasoning history ---- */
{
  const surface = classify({
    errorMessage: '400 The `reasoning_content` in the thinking mode must be passed back to the API.',
    status: 400,
  });
  assert.equal(surface.category, 'context_corruption');
  assert.ok(
    surface.userMessage.includes('思考模式') && surface.userMessage.includes('reasoning'),
    `thinking-mode context error should explain missing reasoning history, got: ${surface.userMessage}`,
  );
  assert.deepEqual(
    surface.actions.map((a) => a.id),
    ['newSession', 'retry'],
  );
  console.log('  [PASS] reasoning_content 400 → context_corruption + precise guidance');
}

/* ---- Test 4: empty errorMessage + status 429 → conservative rate_limit ---- */
/* If the provider only gave us status without a body, we don't know if it's
 * quota or rate limit. Stay on rate_limit so we don't falsely tell the user
 * their plan is exhausted. */
{
  const surface = classify({ errorMessage: '', status: 429 });
  assert.equal(
    surface.category,
    'rate_limit',
    'empty message + 429 → conservative rate_limit (not quota)',
  );
  console.log('  [PASS] empty message + 429 → conservative rate_limit');
}

/* ---- Test 5: gateway raw input length overflow → context_length_exceeded ---- */
{
  const surface = classify({
    errorMessage: 'Input length 148911 exceeds maximum 131072',
    status: 400,
  });
  assert.equal(
    surface.category,
    'context_length_exceeded',
    'raw input length overflow should not fall through to model unavailable',
  );
  assert.ok(
    surface.userMessage.includes('新对话') && surface.userMessage.includes('上一个会话'),
    `context overflow message should mention new-chat continuation path, got: ${surface.userMessage}`,
  );
  const actionIds = surface.actions.map((a) => a.id);
  assert.equal(actionIds[0], 'newSession', 'context overflow should lead with newSession');
  assert.ok(actionIds.includes('retry'), 'context overflow should offer retry after compaction');
  assert.ok(
    actionIds.includes('newSession'),
    'context overflow should offer newSession escape hatch',
  );
  console.log('  [PASS] input length overflow → context_length_exceeded + newSession/retry');
}

/* ---- Test 5b: status 503 but body hints context → context_length_exceeded ---- */
{
  const surface = classify({
    errorMessage: 'upstream error: requested tokens exceed context window',
    status: 503,
  });
  assert.equal(surface.category, 'context_length_exceeded', '503 + token overflow body → context');
  assert.equal(surface.retryable, true);
  console.log('  [PASS] 503 + context hint → context_length_exceeded (beats generic 503)');
}

/* ---- Test 5c: opaque Codex stream failure → service_unavailable ---- */
{
  const surface = classify({ errorMessage: 'LLM stream error: Codex stream error' });
  assert.equal(
    surface.category,
    'service_unavailable',
    'opaque Codex stream failures should not fall through to unknown/config advice',
  );
  assert.equal(surface.retryable, true);
  const actionIds = surface.actions.map((a) => a.id);
  assert.ok(actionIds.includes('retry'), 'transient stream failure should offer retry');
  assert.ok(actionIds.includes('switchModel'), 'transient stream failure should offer switchModel');
  console.log('  [PASS] Codex stream error → service_unavailable + retry/switch');
}

/* ---- Test 5d: abort / unknown branches unchanged ---- */
{
  const userAbort = classify({
    errorMessage: 'Request was aborted',
    abortReason: 'user',
  });
  assert.equal(userAbort.category, 'aborted_by_user');
  assert.equal(userAbort.silent, true, 'user-abort still silent');

  const serverAbort = classify({ errorMessage: 'Request was aborted' });
  assert.equal(serverAbort.category, 'aborted_by_server');

  const unknown = classify({ errorMessage: 'something weird happened' });
  assert.equal(unknown.category, 'unknown');
  console.log('  [PASS] abort + unknown branches unchanged');
}

/* ---- Test 6: alternative quota wordings (openai-style + credits) ---- */
{
  const openaiStyle = classify({
    errorMessage: 'You exceeded your current quota, please check your plan and billing details.',
    status: 429,
  });
  assert.equal(openaiStyle.category, 'quota_exceeded', 'openai-style quota message');

  const credits = classify({
    errorMessage: 'out of credits',
    status: 402,
  });
  assert.equal(credits.category, 'quota_exceeded', 'out of credits → quota_exceeded');

  const insufficient = classify({
    errorMessage: 'insufficient_quota',
    status: 429,
  });
  assert.equal(insufficient.category, 'quota_exceeded', 'insufficient_quota code → quota_exceeded');
  console.log('  [PASS] alternative quota wordings (openai + credits + code)');
}

/* ---- Test 7: `retryable` field semantics
 * Transient / recoverable paths expose retryable=true; quota/auth/unknown/aborted_by_user do not.
 */
{
  const cases = [
    { input: { errorMessage: 'Request was aborted' }, expected: true, label: 'aborted_by_server' },
    {
      input: { errorMessage: '429 too many requests', status: 429 },
      expected: true,
      label: 'rate_limit',
    },
    {
      input: { errorMessage: 'Incorrect API key', status: 401 },
      expected: false,
      label: 'auth',
    },
    {
      input: {
        errorMessage: '429 You have exceeded the monthly usage quota.',
        status: 429,
      },
      expected: false,
      label: 'quota_exceeded',
    },
    {
      input: { errorMessage: 'Request was aborted', abortReason: 'user' },
      expected: false,
      label: 'aborted_by_user (silent)',
    },
    {
      input: {
        errorMessage: 'Input length 90000 exceeds maximum 8192',
        status: 400,
      },
      expected: true,
      label: 'context_length_exceeded',
    },
    {
      input: { errorMessage: 'unknown gibberish' },
      expected: false,
      label: 'unknown',
    },
  ];
  for (const { input, expected, label } of cases) {
    const surface = classify(input);
    assert.equal(
      surface.retryable,
      expected,
      `retryable for ${label} expected ${expected}, got ${surface.retryable}`,
    );
  }
  console.log('  [PASS] retryable field semantics (7 cases)');
}

/* ---- Test 8: opaque stream connection drop is transient service failure, not context overflow ---- */
{
  const surface = classify({
    errorMessage: 'LLM stream error: terminated',
  });
  assert.equal(surface.category, 'service_unavailable');
  assert.equal(surface.retryable, true);
  assert.deepEqual(
    surface.actions.map((a) => a.id),
    ['retry', 'switchModel'],
  );
  console.log('  [PASS] opaque stream connection drop → service_unavailable + retry/switch');
}

/* ---- Test 9: board runtime lifecycle errors get runtime guidance, not generic model advice ---- */
{
  const surface = classify({
    errorMessage: '{"ocCode":"LIFECYCLE_ERROR","message":"Requested agent harness \\"codex\\" is not registered."}',
  });
  assert.equal(surface.category, 'runtime_lifecycle');
  assert.equal(surface.retryable, true);
  assert.ok(surface.userMessage.includes('板端'));
  assert.deepEqual(
    surface.actions.map((a) => a.id),
    ['openBoardAgent', 'retry', 'openSettings'],
  );
  console.log('  [PASS] board lifecycle → runtime_lifecycle + board-agent/retry/settings');
}

console.log('\n[pass] error-classify self-test: 12/12');
