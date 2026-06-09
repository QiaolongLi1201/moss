#!/usr/bin/env node
/**
 * @rdk-moss/agent — fan_out_subagents 工具单测（多代理 fan-out 地基）
 *
 * 验证「2-6 个子代理真并发派发 + 聚合」是否生效，并守住边界（<2 拒、无 spawn 拒、
 * 深度上限、>6 截断、默认只读 scope、失败/异常逐项归并）。
 *
 * 并发性用「最大同时在飞数」确定性证明（不靠 timing）：若串行，maxInFlight 恒为 1；
 * 若并发，全部任务在任一完成前都进入 spawn，maxInFlight == 任务数。
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/agent && node packages/dmoss-agent/test/fan-out-subagents.spec.mjs
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fanOutSubagentsTool } from '../dist/tools/create-subagent.js';

assert.equal(fanOutSubagentsTool?.name, 'fan_out_subagents', '应导出 fan_out_subagents 工具');
assert.equal(fanOutSubagentsTool.metadata?.requiresApproval, false, 'fan-out dispatch should not ask for approval');
assert.equal(fanOutSubagentsTool.metadata?.sideEffectClass, 'subagent', '应是 subagent 类（单次审批、走串行审批闸）');
assert.match(fanOutSubagentsTool.description, /Do not use for quick usage\/config\/help questions/, '工具描述应约束短答/用法问题不要 fan-out');

// ── 1. 真并发 + 聚合 + 默认只读 scope ──
{
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const ctx = {
    spawnSubagent: async (args) => {
      calls.push(args);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(40);
      inFlight -= 1;
      return {
        runId: `run-${calls.length}-deadbeef`,
        sessionKey: 'subagent:run',
        summary: `已审查 ${args.task.slice(0, 12)}`,
        success: true,
      };
    },
  };
  const out = await fanOutSubagentsTool.execute(
    {
      tasks: [
        { task: '审查正确性：逻辑/边界', label: 'correctness' },
        { task: '审查安全：权限/注入', label: 'security' },
        { task: '审查上板安全：会不会跑坏板子', label: 'board-safety' },
      ],
    },
    ctx,
  );
  assert.equal(maxInFlight, 3, '三个子代理应同时在飞（真并发），而非一个接一个');
  assert.ok(out.includes('3 sub-agents ran concurrently'), '应声明并发执行');
  assert.ok(out.includes('3 ok, 0 failed'), '应聚合成功计数');
  assert.ok(
    out.includes('[correctness]') && out.includes('[security]') && out.includes('[board-safety]'),
    '应保留每个视角的标签',
  );
  assert.ok(out.includes('已审查'), '应包含各子代理摘要');
  assert.ok(calls.every((c) => c.scope === 'explore'), '默认 scope 应为 explore（只读，审查不改动）');
  assert.ok(calls.every((c) => c.maxTurns === 4), 'fan-out 默认应浅层探索，避免误触发后长时间工具循环');
}

// ── 2. 失败 / 异常逐项归并，不互相污染 ──
{
  const ctx = {
    spawnSubagent: async (args) => {
      if (args.task.includes('boom')) throw new Error('spawn exploded');
      if (args.task.includes('fail')) return { runId: 'r-fail-00', summary: '子代理判定失败', success: false };
      return { runId: 'r-ok-0000', summary: '通过', success: true };
    },
  };
  const out = await fanOutSubagentsTool.execute(
    {
      tasks: [
        { task: 'good one', label: 'good' },
        { task: 'fail one', label: 'bad' },
        { task: 'boom one', label: 'boom' },
      ],
    },
    ctx,
  );
  assert.ok(out.includes('1 ok, 2 failed'), '混合结果应正确计数');
  assert.ok(out.includes('[good] SUCCESS'), '成功项标 SUCCESS');
  assert.ok(out.includes('[bad] FAILED'), '失败项标 FAILED');
  assert.ok(out.includes('[boom] ERROR'), '抛异常项标 ERROR');
  assert.ok(out.includes('spawn exploded'), '应保留异常原因');
}

// ── 3. 边界守卫 ──
const okCtx = () => ({ spawnSubagent: async () => ({ runId: 'r', summary: 'x', success: true }) });

{
  const r = await fanOutSubagentsTool.execute({ tasks: [{ task: 'only one' }] }, okCtx());
  assert.ok(r.startsWith('Error') && r.includes('at least 2'), '<2 个任务应拒，引导用 create_subagent');
}
{
  const r = await fanOutSubagentsTool.execute({ tasks: [{ task: 'a' }, { task: 'b' }] }, {});
  assert.ok(r.startsWith('Error') && r.includes('not available'), '无 spawnSubagent 应拒');
}
{
  // 空 / 纯空白任务过滤后 <2 → 拒
  const r = await fanOutSubagentsTool.execute({ tasks: [{ task: '   ' }, { task: '' }, { task: 'real' }] }, okCtx());
  assert.ok(r.startsWith('Error') && r.includes('at least 2'), '空白任务过滤后 <2 应拒');
}
{
  const r = await fanOutSubagentsTool.execute(
    { tasks: [{ task: 'a' }, { task: 'b' }] },
    { spawnSubagent: async () => ({ runId: 'r', summary: '', success: true }), maxSpawnDepth: 1, currentSpawnDepth: 1 },
  );
  assert.ok(r.startsWith('Error') && r.includes('depth'), '达到 spawn 深度上限应拒（防无限嵌套）');
}

// ── 4. 上限截断到 6（防失控 fan-out） ──
{
  let count = 0;
  const ctx = { spawnSubagent: async () => { count += 1; return { runId: 'r', summary: '', success: true }; } };
  const out = await fanOutSubagentsTool.execute(
    { tasks: Array.from({ length: 10 }, (_, i) => ({ task: `task ${i}` })) },
    ctx,
  );
  assert.equal(count, 6, '超过 6 个任务应截断到 6');
  assert.ok(out.includes('6 sub-agents ran concurrently'), '截断后声明 6 个');
}

console.log('[fan-out-subagents.spec] PASS');
