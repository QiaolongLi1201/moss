#!/usr/bin/env node
/**
 * @rdk-moss/core — buildAgentBehaviorPrompt 行为准则内容单测
 *
 * 验证「工程方法论已固化进每轮必注入的通用行为准则层」是否生效，并防止后续回归把
 * 既有五段（沟通 / 代码改动 / 忠实报告 / 谨慎执行 / 长期记忆）或新增的「解决问题的方法」改没。
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/core && node packages/dmoss/test/agent-behavior-prompt.spec.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { buildAgentBehaviorPrompt, buildAgentBehaviorPromptQuick } = mod;

assert.equal(typeof buildAgentBehaviorPrompt, 'function', 'buildAgentBehaviorPrompt 应被导出');
assert.equal(typeof buildAgentBehaviorPromptQuick, 'function', 'buildAgentBehaviorPromptQuick 应被导出');

// ── 完整版 ──
const full = buildAgentBehaviorPrompt();
assert.equal(typeof full, 'string', '应返回字符串');
assert.ok(full.length > 200, '应是有实质内容的提示词');

const fullMust = [
  '## 通用 Agent 行为准则',
  // 既有五段（回归守卫）
  '### 沟通风格',
  '### 代码改动纪律',
  '### 忠实报告',
  '### 谨慎执行',
  '### 长期记忆',
  // 新增：解决问题的方法
  '### 解决问题的方法',
  '想清楚再动手',
  '系统化排查',
  '根因',
  '回归检查',
  '闭环验证',
  '复现',
];
for (const marker of fullMust) {
  assert.ok(full.includes(marker), `完整行为准则应包含「${marker}」`);
}

// 三个方法应各自成段且有序：想清楚 → 系统化 → 闭环验证。
// 用 bullet 正文里的独有短语（避开段标题「（想清楚 → 系统化 → 闭环验证）」里重复出现的关键词）。
const idxThink = full.indexOf('想清楚再动手');
const idxDebug = full.indexOf('系统化排查、不猜着试');
const idxVerify = full.indexOf('可验证的目标');
assert.ok(idxThink > 0 && idxDebug > idxThink && idxVerify > idxDebug, '三个方法应按「想清楚→系统化→闭环验证」顺序出现');

// ── 精简版 ──
const quick = buildAgentBehaviorPromptQuick();
assert.equal(typeof quick, 'string', '精简版应返回字符串');
assert.ok(quick.length > 80, '精简版应有内容');
for (const marker of ['解决问题', '根因', '回归检查', '闭环验证']) {
  assert.ok(quick.includes(marker), `精简行为准则应包含方法论关键词「${marker}」`);
}

console.log('[agent-behavior-prompt.spec] PASS');
