# Moss Phase 5 目标

> 生成时间: 2026-05-23
> 前置: Phase 1-4 全部完成，多模型审查已产出

---

## P0 — 安全加固（已全部完成 ✅）

### P0.1 SSRF 通过 redirect 绕过 ✅
**文件**: `packages/dmoss-agent/src/tools/web-fetch.ts:186`
- 已改为 `redirect: 'manual'`，每次重定向前校验目标主机是否 private

### P0.2 危险命令模式补充 ✅
**文件**: `packages/dmoss-agent/src/safety/channel-safety.ts:14-54`
- 已添加 16+ 新模式覆盖提权、反弹 shell、任意代码执行、间接执行等

### P0.3 Secret sanitizer 默认注册 ✅
**文件**: `packages/dmoss-agent/src/core/dmoss-agent.ts`
- 已在 DmossAgent 构造时默认安装 `createSecretSanitizerHook(sanitizeSecrets)`
- 所有工具结果在返回 LLM 上下文前自动脱敏

---

## P1 — 架构收敛（已全部完成 ✅）

### P1.1 Error Classification 统一 ✅
**文件**: `packages/dmoss-agent/src/core/llm-error-classifier.ts`
- `classifyLlmError` 已改为委托 `provider/errors.ts` 中的 `describeError`、`isRateLimitError` 等函数
- 删除了本地重复的 `isRateLimit`、`isConnection`、`isTimeout`、`isServer`、`hasStatus`
- 统一 `provider/error-classify.ts` 为唯一分类源

### P1.2 `currentMessages` 硬帽 ✅
**文件**: `packages/dmoss-agent/src/core/agent-loop.ts`
- 添加 `HARD_CAP_MESSAGE_COUNT = 200` 和 `HARD_CAP_TOTAL_CHARS = 500_000`
- 超过硬帽时强制触发轻量 compaction / prune

### P1.3 文档与导出表对齐 ✅
**文件**: `packages/dmoss-agent/API.md`
- 事件模型已更新为完整的 `MiniAgentEvent` 字段
- 新增 Web Fetch Tool、Agent Mesh 章节和导入路径

---

## P2 — 测试覆盖（已全部完成 ✅）

### P2.1 Overflow Recovery 集成测试 ✅
**文件**: `packages/dmoss-agent/test/overflow-recovery-integration.spec.mjs`
- 6 个测试覆盖 idle→cheap→llm_summarize→truncate 完整状态机
- 验证成功复位、失败传播、streak 重置

### P2.2 Compaction Fallback Chain 测试 ✅
**文件**: `packages/dmoss-agent/test/compaction-fallback.spec.mjs`
- 10 个测试覆盖 LLM 摘要失败 → smaller chunks → deterministic summary → merge priors
- 验证 `compactHistoryIfNeeded`、`createCompactionSummaryMessage`、`extractCompactionSummaryText`

### P2.3 Error Classification 一致性测试 ✅
**文件**: `packages/dmoss-agent/test/error-classification-consistency.spec.mjs`
- 13/13 通过，覆盖 10 种错误场景 × 4 套分类器 + DmossError 可恢复性 + 模式一致性

---

## P3 — 可扩展性（已全部完成 ✅）

### P3.1 `interTurnSilenceMs` 滚动窗口 ✅
**文件**: `packages/dmoss-agent/src/core/agent-loop.ts`
- 添加 `INTER_TURN_SILENCE_WINDOW = 50` 滚动窗口上限
- 超过 50 条时自动 `shift()` 移除最旧数据

### P3.2 Prompt Injection 防护 ✅
**文件**: `packages/dmoss-agent/src/core/dmoss-agent.ts:buildSystemPrompt`
- 系统 prompt 已增加 "Tool Result Handling" 条款
- 明确指示模型不将工具结果中的指令当作可执行命令

### P3.3 globToRegex ReDoS 修复 ✅
**文件**: `packages/dmoss-agent/src/tools/builtin.ts`
- `*` 数量超过 20 时降级为安全字面匹配
- 使用 `[^/]*` 替代 `.*` 避免指数级回溯

---

## 执行顺序建议

```
P0.1 → P0.2 → P0.3    ✅ 已完成 (2026-05-23)
P1.1 → P1.2 → P1.3    ✅ 已完成 (2026-05-23)
P2.1 + P2.2 + P2.3    ✅ 已完成 (2026-05-23)
P3.1 → P3.2 → P3.3    ✅ 已完成 (2026-05-23)
```

每个 P0/P1 修复后都必须跑 `npm run verify` 确认全链路通过。
