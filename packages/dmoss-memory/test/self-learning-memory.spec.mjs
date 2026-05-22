#!/usr/bin/env node
/**
 * @dmoss/memory — self-learning-memory draft generation unit tests
 *
 * Run after package build:
 *   npm run build -w @dmoss/memory && node packages/dmoss-memory/test/self-learning-memory.spec.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const { buildSelfLearningMemoryDraft } = await import(pathToFileURL(distJs).href);

// ── Null/empty inputs ──

// Test: returns null for empty string
{
  const result = buildSelfLearningMemoryDraft('');
  assert.equal(result, null, 'should return null for empty string');
}

// Test: returns null for whitespace-only string
{
  const result = buildSelfLearningMemoryDraft('   \n  \t  ');
  assert.equal(result, null, 'should return null for whitespace-only');
}

// Test: returns null for undefined-ish (treated as string 'undefined')
{
  // compactLine handles falsy: String(text || "") → ""
  const result = buildSelfLearningMemoryDraft(undefined);
  assert.equal(result, null, 'should return null for undefined');
}

// ── No correction pattern → null ──

// Test: returns null for plain question without correction keywords
{
  const result = buildSelfLearningMemoryDraft('How do I configure RDK X5?');
  assert.equal(result, null, 'should return null for plain question');
}

// Test: returns null for plain statement
{
  const result = buildSelfLearningMemoryDraft('The device is running OpenClaw 2.0');
  assert.equal(result, null, 'should return null for plain statement');
}

// Test: returns null for greeting
{
  const result = buildSelfLearningMemoryDraft('Hello, how are you?');
  assert.equal(result, null, 'should return null for greeting');
}

// ── Chinese correction keywords ──

// Test: detects "不对"
{
  const result = buildSelfLearningMemoryDraft('这个输出不对，应该显示板卡信息');
  assert.ok(result !== null, 'should detect 不对');
  assert.ok(result.content.includes('不对'), 'content should include original message');
}

// Test: detects "还是不行"
{
  const result = buildSelfLearningMemoryDraft('改了之后还是不行，USB 没识别到');
  assert.ok(result !== null, 'should detect 还是不行');
}

// Test: detects "奇怪"
{
  const result = buildSelfLearningMemoryDraft('这个行为很奇怪，日志没有更新');
  assert.ok(result !== null, 'should detect 奇怪');
}

// Test: detects "不好用"
{
  const result = buildSelfLearningMemoryDraft('这个按钮不好用，点了没反应');
  assert.ok(result !== null, 'should detect 不好用');
}

// Test: detects "应该"
{
  const result = buildSelfLearningMemoryDraft('应该先加载驱动再配置网络');
  assert.ok(result !== null, 'should detect 应该');
}

// Test: detects "以后"
{
  const result = buildSelfLearningMemoryDraft('以后遇到这种情况直接重启');
  assert.ok(result !== null, 'should detect 以后');
}

// Test: detects "记住"
{
  const result = buildSelfLearningMemoryDraft('记住这个 IP 地址是 192.168.1.100');
  assert.ok(result !== null, 'should detect 记住');
}

// Test: detects "记一下"
{
  const result = buildSelfLearningMemoryDraft('帮我记一下，开发板的 hostname 是 rdk-x5');
  assert.ok(result !== null, 'should detect 记一下');
}

// Test: detects "没改好"
{
  const result = buildSelfLearningMemoryDraft('上次那个问题没改好，又出现了');
  assert.ok(result !== null, 'should detect 没改好');
}

// Test: detects "不太对"
{
  const result = buildSelfLearningMemoryDraft('这个输出结果不太对');
  assert.ok(result !== null, 'should detect 不太对');
}

// Test: detects "不合理"
{
  const result = buildSelfLearningMemoryDraft('这个默认配置不合理，内存占用太高');
  assert.ok(result !== null, 'should detect 不合理');
}

// Test: detects "没有改好"
{
  const result = buildSelfLearningMemoryDraft('还是没有改好，问题依然存在');
  assert.ok(result !== null, 'should detect 没有改好');
}

// ── English correction keywords ──

// Test: detects "not right"
{
  const result = buildSelfLearningMemoryDraft('This output is not right, should show device info');
  assert.ok(result !== null, 'should detect "not right"');
}

// Test: detects "still broken"
{
  const result = buildSelfLearningMemoryDraft('The USB driver is still broken after the update');
  assert.ok(result !== null, 'should detect "still broken"');
}

// Test: detects "doesn't work"
{
  const result = buildSelfLearningMemoryDraft("The camera feed doesn't work after reboot");
  assert.ok(result !== null, 'should detect "doesn\'t work"');
}

// Test: detects "does not work"
{
  const result = buildSelfLearningMemoryDraft('The network does not work on this board');
  assert.ok(result !== null, 'should detect "does not work"');
}

// Test: detects "not good enough"
{
  const result = buildSelfLearningMemoryDraft('The detection accuracy is not good enough');
  assert.ok(result !== null, 'should detect "not good enough"');
}

// Test: detects "remember"
{
  const result = buildSelfLearningMemoryDraft('Remember to always check the power supply first');
  assert.ok(result !== null, 'should detect "remember"');
}

// Test: detects "next time"
{
  const result = buildSelfLearningMemoryDraft('Next time use the HDMI port instead of USB-C');
  assert.ok(result !== null, 'should detect "next time"');
}

// Test: detects "should"
{
  const result = buildSelfLearningMemoryDraft('You should load the kernel module before starting');
  assert.ok(result !== null, 'should detect "should"');
}

// ── Scope determination ──

// Test: product/UX keywords → user scope
{
  const result = buildSelfLearningMemoryDraft('这个用户体验不好用，按钮应该放在工作台上面');
  assert.ok(result !== null, 'should detect correction');
  assert.equal(result.scope, 'user', 'product/UX feedback should have user scope');
}

// Test: product/UX keyword "memory" → user scope
{
  const result = buildSelfLearningMemoryDraft('This memory feature is not working right, should remember my preferences');
  assert.ok(result !== null);
  assert.equal(result.scope, 'user', '"memory" keyword should trigger user scope');
}

// Test: product/UX keyword "workspace" → user scope
{
  const result = buildSelfLearningMemoryDraft('The workspace layout is not right, buttons should be visible');
  assert.ok(result !== null);
  assert.equal(result.scope, 'user', '"workspace" keyword should trigger user scope');
}

// Test: product/UX keyword "chat" → user scope
{
  const result = buildSelfLearningMemoryDraft('Chat history is broken, should show earlier messages');
  assert.ok(result !== null);
  assert.equal(result.scope, 'user', '"chat" keyword should trigger user scope');
}

// Test: non-product correction → workspace scope
{
  const result = buildSelfLearningMemoryDraft('RDK X5 的 GPIO 配置不对，应该用 pin 12');
  assert.ok(result !== null, 'should detect correction');
  assert.equal(result.scope, 'workspace', 'technical correction should have workspace scope');
}

// Test: non-product English correction → workspace scope
{
  const result = buildSelfLearningMemoryDraft('The kernel module is still broken, need to rebuild');
  assert.ok(result !== null);
  assert.equal(result.scope, 'workspace', 'technical correction should have workspace scope');
}

// ── Content structure ──

// Test: content includes feedback prefix
{
  const result = buildSelfLearningMemoryDraft('这个不对');
  assert.ok(result !== null);
  assert.ok(result.content.startsWith('用户反馈/迭代信号:'), 'content should start with feedback prefix');
}

// Test: content includes processing principle
{
  const result = buildSelfLearningMemoryDraft('应该先测试再部署');
  assert.ok(result !== null);
  assert.ok(result.content.includes('处理原则'), 'content should include processing principle');
}

// Test: original message is included in content
{
  const msg = '这个配置不对，应该改一下';
  const result = buildSelfLearningMemoryDraft(msg);
  assert.ok(result !== null);
  assert.ok(result.content.includes(msg), 'content should include original message');
}

// ── Whitespace compaction ──

// Test: whitespace is compacted
{
  const result = buildSelfLearningMemoryDraft('这个   不对\n应该  \t  改一下');
  assert.ok(result !== null);
  assert.ok(result.content.includes('这个 不对 应该 改一下'), 'whitespace should be compacted to single spaces');
}

// ── Long message truncation ──

// Test: long messages are truncated at ~260 chars for the compacted line
{
  const longMsg = '这个不对 '.repeat(60); // ~420 chars
  const result = buildSelfLearningMemoryDraft(longMsg);
  assert.ok(result !== null, 'should still detect correction in long message');
  // The compacted message in content should be truncated
  assert.ok(result.content.includes('...'), 'long content should be truncated with ellipsis');
}

// ── Case sensitivity ──

// Test: English patterns are case-insensitive
{
  const result = buildSelfLearningMemoryDraft('This is NOT RIGHT at all');
  assert.ok(result !== null, 'should detect "NOT RIGHT" case-insensitively');
}

// Test: English "Remember" with capital
{
  const result = buildSelfLearningMemoryDraft('Remember this configuration please');
  assert.ok(result !== null, 'should detect "Remember" with capital R');
}

// ── Return type ──

// Test: returns object with exactly scope and content properties
{
  const result = buildSelfLearningMemoryDraft('不对');
  assert.ok(result !== null);
  assert.ok('scope' in result, 'should have scope property');
  assert.ok('content' in result, 'should have content property');
  assert.equal(Object.keys(result).length, 2, 'should have exactly 2 properties');
}

// Test: scope is valid MemoryScope string
{
  const resultUser = buildSelfLearningMemoryDraft('这个用户体验不好用');
  const resultWs = buildSelfLearningMemoryDraft('这个配置不对');
  assert.ok(resultUser !== null && resultWs !== null);
  assert.ok(['workspace', 'user', 'device', 'learning'].includes(resultUser.scope));
  assert.ok(['workspace', 'user', 'device', 'learning'].includes(resultWs.scope));
}

console.log('[self-learning-memory.spec] PASS');
