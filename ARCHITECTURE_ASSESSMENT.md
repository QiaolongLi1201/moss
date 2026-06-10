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

Moss 是从产品宿主抽离出来的 **host-neutral agent runtime**，目标是让同一套 agent 内核能跑在产品宿主、CLI、未来的 IDE 插件等多种宿主上。架构核心是 **Host Adapter contract**：宿主只需实现 `MossHostRuntimeManifest`，无需触碰 agent 内部。

**6 个 packages**：
| Package | 角色 | 公开发布 |
|---|---|---|
| `@rdk-moss/core` | 类型/契约/工具基类 | ✅ |
| `@rdk-moss/agent` | agent loop、LLM 适配、mesh、扩展注册 | ✅ |
| `@rdk-moss/memory忆与压缩 | ✅ |
| `@rdk-moss/skills` | skill 蒸馏/打分/晋升 | ✅ |
| `@rdk-moss/t| teach-while-solve 注解层 | ✅ |
| `create-dmoss-app` | 脚手架 | ✅ |

---

## 2. 做得好的部分（contrarian 通过、明确不要动）

| # | 优点 | 证据 |
|---|---|---|
| G1 | **Host Adapter 契约**清晰、版本化（`MossHostRuntimeManifest` + contract version），需碰内核 | `packages/dmoss-core/src/host/` |
| G2 | **包边界由脚本守护**：`check:boundaries` + `check:hygiene` 在 `verif中强制，避免 monorepo 退化为大泥球 | `scripts/check-boundaries.mjs`、`package.json:scripts.verify` |
| G3 | **KnowledgeRegistry 已实例化**，每个 `DmossAgent` 拥有自己的 registry；旧的 process-scoped 全局只是 deprecated bridge，多 agent 隔离设计是对的 | `packages/dmoss-agent/src/knowledge/registry.ts:28-202` |
| G4 | **Teaching 层与 agent 解耦良好**：teaching 只 `import type` agent 公共类型 + 1 个 `sanitizeSecrets` 运行时函数，从 `@rdk-moss/agent/core` / `@rdk-moss/agent/safety` 公开导出路径走，不踩内部 | `packages/dmoss-teaching/src/teaching-layer.ts:7-9` |
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
| **不要拆 `@rdk-moss/teaching`** | 它对 agent 是干净的公共依赖；拆开会损失 teach-while-solve 的内聚性 |
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
- `DmossAgent.extensions` 默认创建实例级 `PlatformExtensionRegistry`，并绑定到该 agent 的私有 `KnowledgeRegistry`
- 通过 `getDefaultExtensionsRegistry()` 保留 deprecated free functions 的共享单例
- deprecated `applyPlatformExtension()` / `syncPlatformExtensionsAtStartup()` 会把 extension knowledge 桥到全局 knowledge bridge，确保旧启动流创建的新 agent 仍能拿到当前 legacy knowledge
- deprecated free functions 保留为 backward-compat wrapper，首次调用时 emit warn 遥测

**务实取舍**：
- `agent.extensions.*` 已经是 per-agent 隔离；deprecated free functions 仍是 process-scoped singleton，仅作为兼容迁移路径
- 下游宿主这类旧入口仍可使用 deprecated wrapper，但运行期动态 global mutation 不会自动同步到已经存在的 agent-local registry
- 当前修复的价值：多 agent 默认路径消除 last-agent-wins 串扰，同时保留旧 wrapper 的启动期兼容

**验证**：`test/extensions-singleton.spec.mjs` — 5/5 pass
- 单 agent 不再 wire 到 deprecated singleton
- 双 agent 的 extension knowledge 互不串扰
- 独立 `PlatformExtensionRegistry` 实例完全隔离
- deprecated extension singleton 仍将 knowledge bridge 到未来新建的 agent
- disabled legacy extension 不会误删同 id 的普通全局 knowledge

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

**修正**：下游宿主大量使用这些函数：
- `server/knowledge-modules/device-knowledge-store.ts`：`registerKnowledgeModule`、`getKnowledgeModule`、`unregisterKnowledgeModule`
- `server/knowledge-modules/index.ts`：re-export 全部 deprecated 函数
- `server/dmoss/knowledge-prompt-scope.ts`：`findModuleForPlatform`、`getAllKnowledgeModules`
- 多个 smoke test 脚本

**结论**：在 moss 内部无调用方，但在下游宿主中是活的。删除会破坏下游。保留 `@deprecated` 标记，迁移需要下游宿主先切换到实例 API。

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

- **F1**（teaching → agent 文档化）：在 `dmoss-teaching/README.md` 顶部加一段"我只依赖 `@rdk-moss/agent/core` 和 `@rdk-moss/agent/safety` 两个公共路径"。
- 在 `@rdk-moss/agent` 的 `package.json` 里把 `core`/`safety` subpath exports 显式注释为"稳定 contract，不会在 minor 中破坏"。

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

---

## 9. 第四轮技术债清理（2026-05-28）

> 方法：全仓扫描 + 并行修复 + 验收门全绿

### 清理项

| 项 | 状态 | 证据 |
|---|---|---|
| tree-sitter submodule 零引用 | ✅ 已删除 | `.gitmodules` 清空，`external/tree-sitter` 目录移除 |
| ssh-utils.ts 提取（shellEscape + buildSshCommand 3x 重复） | ✅ 已提取 | `tools/ssh-utils.ts`，device-ssh/ros2/diagnostics 均 import |
| 16 处裸 `as unknown as` cast | ✅ 已修复 | 全部加 runtime guard 或 explanatory comment |
| 37 处 `new Error()` → `DmossError` | ✅ 已转换 | 14 个文件，新增 `MCP_CONNECTION_FAILED` ErrorCode |
| `as any`（非注释） | 0 | `grep` 确认 |
| `@ts-ignore/@ts-nocheck` | 0 | `grep` 确认 |
| `catch(err: any)` | 0 | `grep` 确认 |
| `TODO/FIXME/HACK/XXX` | 0（1 处是 prompt 文本，非代码注释） | `grep` 确认 |
| Dead exports | 0 确认 | 所有 barrel export 均有 importer |
| `console.*` 非 CLI 文件 | 15 处，全部合理 | verbose-guarded / 数据完整性告警 / logger 自身 |
| Unused imports | 0 | typecheck 无 TS6133/TS6196 |

### 验收门

| 检查项 | 结果 |
|---|---|
| `npm run verify` | ✅ 全绿 |
| `npm run lint` | ✅ 0 errors |
| `as any` | 0 |
| `@ts-ignore` | 0 |
| `cli.ts` 行数 | 194 ≤ 200 |
| `agent-mesh.ts` 行数 | 427 |
| `eslint-disable` | 1（合理的 no-control-regex） |
| Test files | 59 pass, 0 fail |

### 剩余演进项（非阻塞）

| 项 | 说明 |
|---|---|
| P2-B channel.ts 多实例隔离 | sessionQueues 泄漏和静默吞错已修，多实例隔离待 host adapter 多宿主上线时 RFC |
| `as unknown as` × 21 | 全部有 guard 或 comment，深层消除需 SessionStore 泛型化 RFC |
| 中文 JSDoc 1434 行 | 风格选择，非 bug；公开 API 3 文件已翻译 |
| P2-E cli/providers.ts 218 行 | 聚焦文件，非杂物间，可选拆分 |

---

## 10. 第五轮多 agent 评审（2026-06-10）

> 方法：4 个角色化并行 agent（A=核心运行时静默 bug / B=契约与 API 面 / C=外围包 / D=反方复核已宣称修复）→ 主线逐条对抗核验（falsify before reporting）→ 修复 + 先红后绿测试。本轮恰逢大量未提交工作树改动（CLI 模型配置新契约迁移中），以未提交 diff 为最高风险面。

### 10.1 修复项（fix now，全部闭环）

| # | 问题 | 严重度 | 修复 | 测试 |
|---|---|---|---|---|
| R5-1 | **candidate id `'.'` 守卫缺口**：守卫只拦 `/` `\` `..`，`path.join(root, '.') === root`，导致 `removeCandidate(ws,'.')` rm -rf 整个 candidates 根；`promoteSkillCandidate('.')`、TUI `/skills discard .`、`/skills forget .` 同形（一类四处） | P0 数据丢失 | `skill-candidate-store.ts` 新增共享 `isUnsafeCandidateId()`（入 barrel），promoter 复用；TUI 两处内联拒绝 `'.'` | `test/candidate-id-guard.spec.mjs` 先红（旧实现真的删库）后绿 |
| R5-2 | **check-oss-boundaries 扫描 gitignored 发布产物**：本机存在 `zero-config-default.json`（设计上 gitignore、发布期生成、含公网网关 token）即 verify 永久红 | P1 误报阻塞 | walker 经 `git check-ignore --stdin` 跳过 git 忽略文件；git 不可用时回退全扫（失败模式只会更严） | 负向探针：untracked 可提交文件含禁词仍被抓 → 检查强度未削弱 |
| R5-3 | **固定 `.tmp` 后缀原子写 ×5**：并发写者互相截断同一 tmp 文件可 rename 出 torn JSON；失败路径泄漏 .tmp（skills/memory 处无清理） | P2 并发硬化 | skills 新建共享 `fs-atomic.ts`（store+promoter 复用）；`agent/utils/atomic-write.ts`、`memory-manager.ts`×2 改唯一 tmp 名（pid+随机）+ 失败清理 | guard spec 含 12 并发写 smoke：无 torn JSON、无 .tmp 残留 |
| R5-4 | **URL 规范化双份实现**（cli/setup.ts 本地 `stripEndpointSuffix` vs provider/api-v1-url.ts）会漂移 | P2 | 删除 setup.ts 本地副本，`api-v1-url.ts` 导出单一事实源并注明双调用方 | 既有 api-v1-url + cli-config-setup spec 全过 |
| R5-5 | **三处进程级单例缺设计意图注释**（CLAUDE.md 规则）：pending-tool-aborts、background-exec registry、tool-output-truncate limits | P2 | 各补 DESIGN INTENT 注释（keying/TTL/unref 论证 + 重开触发条件） | 新增 `test/pending-tool-aborts.spec.mjs`：会话隔离 + 恰好一次消费 |
| R5-6 | **新模型配置契约的测试迁移缺口**：`IGNORED_MODEL_ENV_VARS` 新契约（模型配置只认 CLI flag > config 文件 > 内置，env 仅警告）落地后，多个 spec 仍用 `DMOSS_API_KEY` 等 env 配置模型 → 失败 | P1（阻塞 verify） | cli-identity、cli-install-skill-toolcall、cli-provider-routing 改为 config 文件注入 key/provider/baseUrl（与维护者并行更新的 cli-config-setup、cli-bundled-default、cli-runtime-capabilities 同向收敛）；cli-zero-config-install EACCES 分支加 mode-bits 强制探测（overlay/沙箱可移植） | 全部转绿；零配置 install 四断言保留 |
| R5-7 | 文档落地：host-adapter-contract.md 新增「合约版本升版政策」（合约 bump ⇒ 至少 minor，包版本 bump ⇏ 合约 bump）；teaching README 顶部依赖面声明（§5 P3 闭环） | P3 | — | hygiene markdown 链接检查通过 |

### 10.2 推翻项（rejected — 不要再提）

| 假设（来源） | 推翻理由 |
|---|---|
| AGENTS.md 被改成 stub、丢失方法论（D） | 误读 diff：现行 AGENTS.md 完整镜像 CLAUDE.md 全部方法论章节 |
| README `/upgrade` 命令不存在（D） | `cli/interactive-commands.ts:71` 实现存在 |
| candidate store 缺 schemaVersion（C） | candidate.json 是内部管线短命产物；P1-C 针对的是 promoted skill（已修），无读取方需求 |
| node 版本检查双重初始化（A） | `enforceNodeVersion()` 幂等，cli-main 无重复调用 |
| TUI goal turns 跨 run 累计是 bug（A） | 注释明示的设计意图，goal 结束时 `setGoalActivity(null)` 重置 |
| approval-detail LCS 回溯越界（A） | dp 为 (n+1)×(m+1)，自证无越界 |

### 10.3 搁置项（deferred，含重开触发条件）

| 项 | 触发条件 |
|---|---|
| `idempotent` 字段 + in-flight 去重未实现（B）— RFC 明确 "draft for review before runtime changes"，declared-without-reader 反而违反自家纪律 | RFC 评审通过 |
| pending-tool-aborts / background-exec / tool-output-truncate 全面实例化（D） | host-adapter 多租户 RFC（与 §9 P2-B channel.ts 同桶；本轮已补注释+隔离测试） |
| API 稳定性 TSDoc 全量标注（P1-1 维持原计划） | 按季度计划执行 |
| cf5e102 将 cwd-fallback 断言从「精确 home」放宽为「绝对路径且≠badCwd」属轻微弱化（D5） | 若 cwd fallback 行为出现回归，收紧为 normalize 后等值断言 |

### 10.4 验收门（沙箱挂载禁 unlink，verify 各步拆分执行）

| 检查项 | 结果 |
|---|---|
| check:boundaries / check:hygiene | ✅ OK / OK |
| build（增量 tsc，全 6 包） | ✅ |
| typecheck | ✅ 0 错误 |
| lint | ✅ 0 错误 |
| 测试 | ✅ core 5、skills 9（含新 guard spec）、memory 6、teaching 3、create-dmoss-app 3、agent 全量 130+（含 cli-tui、新 pending-tool-aborts spec），0 失败 |

> 备注：zero-config-default.json 内的公网网关 token 属设计而非泄露（example 文件明示「PUBLIC gateway token，上游 key 在服务端」）；边界检查现已与该发布设计对齐。本轮 6 项发现被推翻、7 项修复落地，再次印证「初判必有两三成是错的」。
