# Moss Agent 架构评估报告

> 方法：architecture-assessment 三阶段（假设 → 多 agent 碰撞 → 综合定案）
> 评估范围：`moss/` monorepo（6 个 npm workspaces，约 ~25k LOC）
> 日期：2026-05-27

---

## 0. 阅读须知

本报告经过三阶段处理：
1. **Phase 1（假设生成）**：单 agen，产出初始问题清单（共识：是假设，不是结论）。
2. **Phase 2（多角色碰撞）**：并行派发 3 个对抗性 agent（结构 / 稳定性 / 反方）独立核源码。
3. **Phase 3（综合）**：按"证据强度 > 多数票"原则合并裁决。
执行情况**：
- ✅ Phase 2-A（结构）：成功，22 项核验
- ❌ Phase 2-B（稳定性）：agent 超时（10 分钟无输出），未完成
- ✅ Phase 2-C（反方）：成功，挑出 3 项被高估、补 4 项被遗漏

**稳定性维度的补救**：主线手工核验了 4 个关键点（KnowledgeRegistry 并发、extensions/registry 单例、cliProvider 流契约、secret sanitizer 走查），其余稳定性结论标注为"未完整碰撞"。

---

## 1. 项目背景

Moss 是从 RDK Studio 抽离出来的 **host-neutral agent runtime**，目标是让同一套 agent 内核能跑在 RDK Studio、CLI、未来的 IDE 插件等多种宿主上。架构核心是 **Host Adapter contract**：宿主只需实现 `MossHostRuntimeManifest`，无需触碰 agent 内部。

**6 个 packages**：
| Package | 角色 | 公开发布 |
|---|---|---|
| `@dmoss/core` | 类型/契约/工具基类 | ✅ |
| `@dmoss/agent` | agent loop、LLM 适配、mesh、扩展注册 | ✅ |
| `@dmoss/memory忆与压缩 | ✅ |
| `@dmoss/skills` | skill 蒸馏/打分/晋升 | ✅ |
| `@dmoss/t| teach-while-solve 注解层 | ✅ |
| `create-dmoss-app` | 脚手架 | ✅ |

---

## 2. 做得好的部分（contrarian 通过、明确不要动）

| # | 优点 | 证据 |
|---|---|---|
| G1 | **Host Adapter 契约**清晰、版本化（`MossHostRuntimeManifest` + contract version），需碰内核 | `packages/dmoss-core/src/host/` |
| G2 | **包边界由脚本守护**：`check:boundaries` + `check:hygiene` 在 `verif中强制，避免 monorepo 退化为大泥球 | `scripts/check-boundaries.mjs`、`package.json:scripts.verify` |
| G3 | **KnowledgeRegistry 已实例化**，每个 `DmossAgent` 拥有自己的 registry；旧的 process-scoped 全局只是 deprecated bridge，多 agent 隔离设计是对的 | `packages/dmoss-agent/src/knowledge/registry.ts:28-202` |
| G4 | **Teaching 层与 agent 解耦良好**：teaching 只 `import type` agent 公共类型 + 1 个 `sanitizeSecrets` 运行时函数，从 `@dmoss/agent/core` / `@dmoss/agent/safety` 公开导出路径走，不踩内部 | `packages/dmoss-teaching/src/teaching-layer.ts:7-9` |
| G5 | **AgentMesh 走的是 `agehat()`**，approval/teaching hooks 不会被绕过；远端 peer 调用与本地一致 | `packages/dmoss-agent/src/agent-mesh.ts` 中的 `handleChat` |
| G6 | **Skill 蒸馏管线分层清晰**：distill → score → promote，纯函数化、可单测 | `packages/dmoss-skills/src/` |
| G7 | **Secret sanitization** 在 LLM 出入两侧都接入，teaching 层调用前后均走 `sanitizs` | `teaching-layer.ts:91,182,211,295,346,360` |

> Phase 1 一度怀疑 G3/G4/G5 是问题，碰撞后均被推翻。**这些是核心架构的承重点，不要动。**

---

## 3. 修正后的核心问题清单

下表展示「Phase 1 初判 → Phase 2 碰撞裁决 → 最终定级」：

| ID | 初判 | 碰撞裁决 | 最终严重度 | 证据 |
|---|---|---|---|---|
| **F1** | teaching → agent 形成循环耦合（P0） | **REJECTED / OVERSTATED**：实际为 type-only import + 1 runtime fn，走公共路径 | **P3（仅文档建议）** | `packages/dmoss-teaching/src/teaching-layer.ts:7-9`、`packages/dmoss-teaching/package.json:36-39` |
| **F2** | `KnowledgeRegistry.drainPendingGlobalModules` 不清空 pending 数组，多 agent 重复注册（P1） | **DOWNGRADED**：`registerKnowledgeModule()` 无任何调用方，是 dead code；问题真实但影响域为 0 | **P2（清理）** | `packages/dmoss-agent/src/knowledge/registry.ts:219-239`，codegraph_callers 返回空 |
| **F3** | AgentMesh 绕过 approval/teaching（P2） | **REJECTED / WRONG**：`agent.chat()` 已经走 `streamChat`，hooks 全在 | **不立项** | `agent-mesh.ts` 中 `handleChat` → `this.agent.chat()` |
| **F4** | `cli.ts` 908 行需要拆分（P3| **PARTIALLY VERIFIED**：体量 OK，但混了 3 个职责（CLI 入口 + 2 个 LLM provider） | **P2** | `packages/dmoss-agent/src/cli.ts:341,361,419` |
| **F5** | `agent-mesh.ts` 763 行需要拆分（P3） | **VERIFIED**：HTTP server + rate-limiter + peer registry + handlers 全挤一起 | **P2** | `packages/dmoss-agent/src/agent-mesh.ts` |
| **F6**（new）| Phase 1 漏掉的真正并发 bug：`extensions/registry.ts` 全是 module-level 可变单例 | **CONFIRMED by 反方 + 主线手工核验** | **P0** | `packages/dmoss-agent/src/extensions/registry.ts:18,25,36,72` |
| **F7**（new）| `cliProvider` 把 `stream` 请求伪装成完整响应一次性返回，违反 `LLMProvider` 流式契约 | **CONFIRMED by 结构 agent** | **P0** | `packages/dmoss-agent/src/cli.ts:341` 起 |
| **F8**（new）| 6 个 public package 全部 `private: false`，但 `exports`/`API stability` 没有任何注释或 `@beta`/`@stable` 标记 | **CONFIRMED by 反方** | **P1** | 所有 `packages/*/package.json` |
| **F9**（new）| `_knowledgeRegistry`、`vendorCallbacks`、`lastApplied`、`cachedExtensions` 4 个 module-level 状态，多 agent / 测试隔离都会污染 | **CONFIRMED by 主线手工核验** | **P0**（与 F6 合并行动） | `packages/dmoss-agent/src/extensions/registry.ts:18,25,36,72` |

---

## 4. 关键的"不要改"

这一节和优化清单同等重要。以下都是 Phase 1 想动、被 Phase 2 拦下的东西：

| 项 | 为何不动 |
|---|---|
| **不要拆 `@dmoss/teaching`** | 它对 agent 是干净的公共依赖；拆开会损失 teach-while-solve 的内聚性 |
| **不要重写 `KnowledgeRegistry`** | 实例化设计已经正确，问题在它**外面**（extensions/registry 的全局单例） |
| **不要给 AgentMesh 重新加一层 approval 拦截** | `agent.chat()` 已经走完整 pipeline，再加一层只会重复 + 制造不一致 |
| **不要为了"行数"硬拆 `dmoss-agent.ts (859)`** | 这是 facade 类，行数主要来自构造期一次性 wiring，拆开反而模糊主线 |
| **不要急着上 `vitest` 全面铺测** | 现有 `run-package-tests.mjs` 已经在 verify 流水里，先把验证缺口补齐（见 P1） |

---

## 5. 优先级行动清单

### 🔴 P0 — 必须立即处理（多 agent / 多宿主场景下会产生静默 bug）

#### P0-1：消除 `extensions/registry.ts` 的所有 module-level 可变状态 ✅
**文件**：`packages/dmoss-agent/src/extensions/registry.ts`

**问题**：4 个全局 mutable 变量（`vendorCallbacks`、`_knowledgeRegistry`、`lastApplied`、`cachedExtensions`）让"两个 DmossAgent 实例同时存活"这件事行为不可预测。

**方案（已实施）**：
- 将 4 个 module-level 变量封装为 `PlatformExtensionRegistry` 类
- 通过 `getDefaultExtensionsRegistry()` 暴露共享单例
- `DmossAgent.extensions` 指向该共享单例，确保 deprecated free functions（rdstudio-web 仍在用）与 agent 实例方法操作同一状态
- deprecated free functions 保留为 backward-compat wrapper，首次调用时 emit warn 遥测
- 第二个 DmossAgent 构造时 emit warn："Multiple DmossAgent instances sharing singleton"

**务实取舍**：
- 当前实现是 shared singleton（非 per-agent 隔离），因为 rdstudio-web 的 `setVendorPluginCallbacks()` / `applyPlatformExtension()` 仍走 deprecated 路径
- 真正的多 agent 隔离需要 rdstudio-web 先迁移到 `agent.extensions.*` API
- 当前修复的价值：散落的 module-level 状态变成了内聚的 class API + 可观测的迁移压力

**验证**：`test/extensions-singleton.spec.mjs` — 3/3 pass
- 单 agent 正确 wire 到 singleton
- 双 agent 共享 singleton（documented limitation）
- 独立 `PlatformExtensionRegistry` 实例完全隔离（为未来迁移铺路）

---

#### P0-2：修复 `cliProvider` 的流式契约违规 ✅
**文件**：`packages/dmoss-agent/src/core/llm/llm-provider.ts`、`llm-provider-stream-adapter.ts`、`cli.ts`

**问题**：cliProvider 把 `stream()` 请求伪装成完整响应一次性返回，token 抵达延迟从"首 token <500ms"变成"全文 N 秒"。

**方案（已实施）**：
- `LLMProvider` 接口新增 `capabilities?: { streaming?: boolean }`
- `cliProvider` 声明 `capabilities: { streaming: false }`
- `createStreamFunctionFromLlmProvider` 读取 capabilities：
  - `streaming !== false`（默认）：走 `provider.stream()` + 实时 event forwarding
  - `streaming === false`：走 `provider.complete()` + 从完整响应 emit synthetic events
- 非流式 provider 不再被误调 `stream()`，避免无意义的 API 调用

**验证**：`test/llm-provider-stream-adapter.spec.mjs` — 新增 non-streaming 测试
- `complete()` 被调用，`stream()` 未被调用
- synthetic events（text_end, done）正确 emit
- result 包含正确的 stopReason 和 usage

---

### 🟠 P1 — 本季度内修

#### P1-1：标注 6 个 public package 的 API 稳定性
**文件**：所有 `packages/*/package.json` + 每个 `src/index.ts`

**问题**：包都是 `"private": false` + `"publishConfig.access": "public"`，但外部使用者无法判断哪些 export 是稳定 API、哪些是内部实现。一个 patch release 就可能 break 下游。

**方案**：
- 在 `package.json` 加 `"stability": "alpha" | "beta" | "stable"` 字段（自定义约定）。
- 在每个 export 上加 TSDoc `@public` / `@beta` / `@internal` 标签。
- 在每个包的 `src/index.ts` 顶部加 banner 说明当前阶段。
- 提交 `api-extractor` 或最少手写一份 `API.md` snapshot，纳入 verify 流水。

**验证**：`npm pack --dry-run` + 对比 `dist/index.d.ts` 是否只暴露标注为 `@public` 的符号。

---

#### P1-2：~~清理 dead code（`registerKnowledgeModule` 全家桶）~~ **REJECTED**

**原判断**：`defaultRegistry`、`pendingGlobalModules`、`drainPendingGlobalModules`、`registerKnowledgeModule` 等 deprecated 全局桥接器，codegraph_callers 查到 moss 内部无调用方，认为是 dead code。

**修正**：rdstudio-web 大量使用这些函数：
- `server/knowledge-modules/device-knowledge-store.ts`：`registerKnowledgeModule`、`getKnowledgeModule`、`unregisterKnowledgeModule`
- `server/knowledge-modules/index.ts`：re-export 全部 deprecated 函数
- `server/dmoss/knowledge-prompt-scope.ts`：`findModuleForPlatform`、`getAllKnowledgeModules`
- 多个 smoke test 脚本

**结论**：在 moss 内部无调用方，但在 rdstudio-web 中是活的。删除会破坏下游。保留 `@deprecated` 标记，迁移需要 rdstudio-web 先切换到实例 API。

**教训**：codegraph_callers 只查 monorepo 内部。跨仓库依赖需要额外检查（`rg` 整个 workspace）。

---

#### P1-3：补齐稳定性维度的碰撞证据
（Phase 2-B 未完成的补救）

**做什么**：
- 跑一遍 `rg "catch \(.*\) \{$" packages/*/src` 列出所有 catch 块，分类 swallow / log / rethrow。
- 跑一遍 `rg "process\.env\." packages/*/src` 列出所有读环境变量的位置，确认是否有 schema 校验。
- 跑一遍 `rg "await Promise\.all|Promise\.race" packages/*/src` 找潜在并发热区。

**输出**：一份 `docs/STABILITY-AUDIT.md`，每类一段。

---

### 🟡 P2 — 有空再做（净化型）

#### P2-1：拆 `cli.ts (908)`
按职责切：
- `cli/entrypoint.ts`（argv parsing、main loop）
- `llm/anthropic-direct.ts`（`callAnthropic`）
- `llm/openai-direct.ts`（`callOpenAI`）
- `llm/cli-provider.ts`（`cliProvider` 适配器，连带 P0-2 修复）

#### P2-2：拆 `agent-mesh.ts (763)`
按职责切：
- `mesh/server.ts`（HTTP 服务）
- `mesh/rate-limiter.ts`
- `mesh/peer-registry.ts`
- `mesh/handlers/*.ts`（chat / status / cancel / ...）

#### P2-3：把 P0-1 之后剩下的 `pendingGlobalModules` 数组也彻底删除（与 P1-2 合并）

---

### 🟢 P3 — 可选改进（不阻塞）

- **F1**（teaching → agent 文档化）：在 `dmoss-teaching/README.md` 顶部加一段"我只依赖 `@dmoss/agent/core` 和 `@dmoss/agent/safety` 两个公共路径"。
- 在 `@dmoss/agent` 的 `package.json` 里把 `core`/`safety` subpath exports 显式注释为"稳定 contract，不会在 minor 中破坏"。

---

## 6. 方法论侧的备注

- Phase 1 给出了 8 个问题，其中 **3 个被碰撞推翻**（F1/F2 降级、F3 撤销），**4 个新问题在碰撞中浮现**（F6-F9）。如果直接采纳 Phase 1 就会去拆 teaching 包、给 mesh 加冗余 approval、错过真正的 P0（extensions/registry 单例 + cliProvider 假流）。
- 这印证 architecture-assessment 的核心断言：**初判一定有 2-3 处错的，碰撞是必要工序，不是 nice-to-have**。
- Phase 2-B 失败本身是一个信号：把"稳定性"塞给一个 agent 全包的范围太大，下次应该拆成 "test coverage audit" + "error handling audit" + "config externalization audit" 三个更窄的子任务并行。

---

## 7. 一行总结

> Moss 的**架构骨架是健康的**（Host Adapter、KnowledgeRegistry 实例化、teaching 解耦都做对了）。两个 P0 已闭环：**`extensions/registry.ts` 全局单例**封装为 class + 遥测 + 测试；**`cliProvider` 假流式**通过 capabilities 声明 + adapter 路由 + 测试修复。剩余的是 P1/P2 清扫和文档工作。

---

## 8. 第三轮复审（2026-05-27 晚）

> 方法：3 个并行验证 agent 对 13 项发现逐条读源码裁决，主线综合

### 裁决表

| 项 | 裁决 | 修复 |
|---|---|---|
| **P1-A** command-queue.ts 全局 lanes Map | ✅ 确认 | `CommandQueueRegistry` class + deprecated wrapper + DmossAgent 持有实例 |
| **P1-B** agent-loop-push-guard.ts 无界 Map | ✅ 确认 | 加 MAX_MAP_SIZE=1000 / TRIM_TO_SIZE=500 LRU 清理 |
| **P1-C** Skill schema 缺 schemaVersion | ✅ 确认 | JSON 和 YAML frontmatter 均加 `schemaVersion: 1` |
| **P1-D** create-dmoss-app 模板假流式 | ✅ 确认 | minimal 模板改用 `AnthropicLLMProvider`，openai 模板改用 `OpenAILLMProvider` |
| **P2-A** builtin.ts execSync 忽略 abortSignal | ✅ 确认 | `execSync` → `runProcess`，AbortSignal 链路打通 |
| **P2-B** channel.ts sessionQueues 单例 | ⚠️ 部分确认 | singleton 是真的，但错误问题是 unhandled rejection 不是 silent catch；合并到后续 RFC |
| **P2-C** keep-alive-dispatcher.ts module-level let | ❌ 推翻 | process-wide 连接池单例是设计意图，不是 bug |
| **P2-D** P0-1 局部回归 `_deprecatedWarned` | ✅ 确认 | boolean → `Set<string>`（per-function warn）；`=== 2` → `>= 2` |
| **P2-E** cli/providers.ts 过大 | ❌ 推翻 | 218 行聚焦文件，两个 provider + 一个 adapter，结构清晰 |
| **P3-1** check-oss-boundaries.mjs match 只找首个 | ✅ 确认 | `match` → `matchAll`；`.includes()` → `===` 严格相等 |
| **P3-2** CONTRACT_VERSION 硬编码 | ✅ 确认 | 低优先级，暂不修 |
| **P3-3** tree-sitter submodule 零引用 | ✅ 确认 | 低优先级，暂不清理 |
| **P3-4** mesh/transport.ts catch 不 log | ✅ 确认 | 加 `log.warn` 输出错误详情 |
| **G6** Skill 蒸馏纯函数化 | ❌ 推翻 | skill-distiller/skill-candidate-store 直接做 fs I/O，不是纯函数 |

### 验证结果

`npm run verify` 全绿：boundaries + hygiene + build + typecheck + lint (0 errors) + test (53+3+3 files, 0 fail)
