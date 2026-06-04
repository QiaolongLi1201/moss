#!/usr/bin/env node
/**
 * @rdk-moss/memory — knowledge-card distillation unit tests
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/memory && node packages/dmoss-memory/test/knowledge-card.spec.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const { buildKnowledgeCardDraft, classifyLearningTopic, coerceLearningTopic, assessKnowledgeTurn } = await import(
  pathToFileURL(distJs).href
);

const LONG_ANSWER = '这是一个足够长的解答内容，用于通过最小长度校验，描述了具体的操作步骤和原因。'.repeat(5);

// ── classifyLearningTopic ──
{
  assert.equal(classifyLearningTopic('USB Type-C 没识别到网卡'), 'usb');
  assert.equal(classifyLearningTopic('如何启动 ROS2 节点和话题'), 'ros');
  assert.equal(classifyLearningTopic('BPU 模型量化推理怎么做'), 'hbm');
  assert.equal(classifyLearningTopic('摄像头 mipi 画面推流不出来'), 'vision');
  assert.equal(classifyLearningTopic('ssh 连不上，ping 不通，wifi 配置'), 'network');
  assert.equal(classifyLearningTopic('如何烧录镜像并 apt 安装依赖'), 'deploy');
  assert.equal(classifyLearningTopic('RDK X5 是什么'), 'general');
}

// ── coerceLearningTopic ──
{
  assert.equal(coerceLearningTopic('ros'), 'ros');
  assert.equal(coerceLearningTopic('ROS'), 'ros');
  assert.equal(coerceLearningTopic('nope'), undefined);
  assert.equal(coerceLearningTopic(123), undefined);
  assert.equal(coerceLearningTopic(undefined), undefined);
}

// ── buildKnowledgeCardDraft: trivial turns → null ──
{
  assert.equal(buildKnowledgeCardDraft({ userMessage: '', assistantMessage: LONG_ANSWER }), null);
  assert.equal(buildKnowledgeCardDraft({ userMessage: '你好', assistantMessage: LONG_ANSWER }), null, '问候应跳过');
  assert.equal(buildKnowledgeCardDraft({ userMessage: '怎么用 RDK', assistantMessage: '好的' }), null, '答案过短应跳过');
  assert.equal(buildKnowledgeCardDraft({ userMessage: 'hi', assistantMessage: LONG_ANSWER }), null);
}

// ── buildKnowledgeCardDraft: substantive turn → card ──
{
  const card = buildKnowledgeCardDraft({
    userMessage: '如何在 RDK X5 上用 USB Type-C 直连电脑？',
    assistantMessage: '把 Type-C 线插到板子的 USB 口，主机会出现一个 RNDIS 网卡，' + LONG_ANSWER,
    toolsUsed: ['device-ssh', 'typec-verify-ip'],
  });
  assert.ok(card !== null, '应产出卡片');
  assert.equal(card.topic, 'usb', 'topic 应为 usb');
  assert.ok(card.title.length > 0 && card.title.length <= 40, 'title 长度合理');
  assert.ok(!card.title.startsWith('如何'), '标题应去掉"如何"前缀');
  assert.ok(card.content.includes('问题：'), '内容含问题段');
  assert.ok(card.content.includes('解答：'), '内容含解答段');
  assert.ok(card.content.includes('涉及工具：device-ssh、typec-verify-ip'), '内容含工具');
}

// ── 无工具时不渲染工具段 ──
{
  const card = buildKnowledgeCardDraft({
    userMessage: 'RDK X5 的 BPU 算力是多少，怎么部署模型？',
    assistantMessage: 'RDK X5 提供 10 TOPS 等效算力，模型需经过量化转换为 hbm 格式后用 BPU 推理。' + LONG_ANSWER,
  });
  assert.ok(card !== null);
  assert.equal(card.topic, 'hbm');
  assert.ok(!card.content.includes('涉及工具'), '无工具时不应有工具段');
}

// ── 长答案截断 ──
{
  const huge = 'x'.repeat(5000);
  const card = buildKnowledgeCardDraft({
    userMessage: '请详细介绍 RDK 的网络配置方法',
    assistantMessage: huge,
  });
  assert.ok(card !== null);
  assert.ok(card.content.length < 2000, '超长答案应被截断');
  assert.ok(card.content.includes('…'), '截断应带省略号');
}

// ── assessKnowledgeTurn ──
{
  // 项目相关（USB + 工具）→ worth + projectRelated
  const a = assessKnowledgeTurn({
    userMessage: '如何在 RDK X5 上用 USB Type-C 直连电脑？',
    assistantMessage: '把 Type-C 线插到板子，主机出现 RNDIS 网卡，' + LONG_ANSWER,
    toolsUsed: ['device-ssh'],
  });
  assert.equal(a.worth, true, '项目相关应值得沉淀');
  assert.equal(a.projectRelated, true);
  assert.equal(a.topic, 'usb');
}
{
  // 问候 → 不值得
  const a = assessKnowledgeTurn({ userMessage: '你好', assistantMessage: LONG_ANSWER });
  assert.equal(a.worth, false, '问候不应自动沉淀');
}
{
  // 琐碎查询、短答、无工具、非项目 → 不达自动门槛
  const a = assessKnowledgeTurn({
    userMessage: '看下现在有多少积分',
    assistantMessage: '你当前有 120 积分。',
  });
  assert.equal(a.worth, false, '琐碎短答不应自动沉淀');
}
{
  // 充实的通用技术答案（无工具、非项目词）→ worth 由 substantive 命中
  const a = assessKnowledgeTurn({
    userMessage: '请解释一下什么是边缘计算',
    assistantMessage: '边缘计算是把计算放到靠近数据源的一侧……' + LONG_ANSWER,
  });
  assert.equal(a.worth, true, '充实答案应可沉淀');
}

console.log('[knowledge-card.spec] PASS');
