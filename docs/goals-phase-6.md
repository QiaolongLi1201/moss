# Moss Phase 6 目标

> 生成时间: 2026-05-23
> 前置: Phase 5 (P0安全/P1架构/P2测试/P3可扩展) 全部完成
> 审阅: Claude Opus 4.7 + Claude Sonnet 4.6 + RDK Studio 宿主方
> 预计: 15-20 天

---

## 审阅共识

三方的核心结论高度一致：

| 审阅方 | 核心意见 |
|--------|---------|
| **Opus 4.7** | Host Adapter 必须先锁，E2E 在编排之前，Tree-sitter 推迟到 Phase 7，spawn-profile 有全局状态 bug 需修 |
| **Sonnet 4.6** | A.3 运行时协议是最大风险，quick win 用 grep search_code 替代 tree-sitter，cut Tree-sitter 保其他四个 |
| **RDK Studio** | contract-first + fixture host + conformance tests；mesh 需稳定事件协议；E2E 需可回放素材；observability 默认脱敏 |

**行动**: Tree-sitter 整体移入 Phase 7。Host Adapter 升为 Week 1 唯一焦点。Mesh 补事件协议。E2E 补 mock/golden 素材。Observability 补 redaction layer。

---

## A — Host Adapter v1 正式合约 (5-7 天) 🔴 最高优先级

> **原则: contract-first。Moss 交付的不是实现，是可被测试冻结的合约。**

### A.1 合约产物（不只是代码）

交付给宿主方的完整合约包：

- **JSON Schema / TypeScript contract**: 从 `host-adapter.ts` 生成可机器校验的 schema
- **Fixture host manifest**: 一个完整、正确的参考 manifest，宿主可直接复制修改
- **Conformance test suite**: 宿主编写自己的 manifest 后，跑 conformance 测试验证「我是否正确实现了合约」
- **Version negotiation 规则**: 宿主声明 `minContractVersion` + `maxContractVersion`，Moss 运行时协商可接受的版本
- **Breaking change policy**: 什么算 breaking change，minor/patch 各允许多大改动，migration 窗口多长

**当前状态**: `packages/dmoss/src/contracts/host-adapter.ts` (238 行)，`MOSS_HOST_ADAPTER_CONTRACT_VERSION = 1`，13 种 capability kind，`evaluateMossHostCompatibility()` 含 6 种 failure mode。但纯类型定义——无运行时协议实现。

### A.2 兼容性测试体系

- `evaluateMossHostCompatibility()` 单元测试：覆盖全部 6 种 failure mode + 正常路径
- manifest schema validator（手写或 Zod）
- fixture manifest 作为 conformance test 的输入

### A.3 最小 CLI 宿主（fixture host）

- 不是 `create-dmoss-app` 完整脚手架——先做一个 fixture 级别的 host
- 仅依赖 `@dmoss/agent` + `@dmoss/core`，不引 RDK Studio 代码
- 目标：能用它跑通一轮 agent 对话 = 合约合格
- 产出：mock LLM provider + mock session store + mock tool set

### A.4 RDK Studio 对接

- RDK Studio 侧 `moss:update` 通过 → 记录宿主适配器变更清单
- 确认所有 capability kind 至少有一个宿主实现
- 向后兼容：RDK Studio 运行 pre-v1 Moss 时的降级路径

---

## B — Agent Mesh 多智能体协作 (4-5 天)

### B.0 前置修复：spawn-profile 全局状态 bug
**文件**: `packages/dmoss-agent/src/core/spawn-profile.ts`

- `_hostSpawnToolExtensions` 是模块级可变 singleton——并发子智能体会互相污染
- 改为实例级或 request-scoped 注册

### B.1 稳定事件协议（对外合约）

Agent Mesh 不靠文本解析，而是靠结构化事件。Studio UI 和日志系统直接消费：

```
child_run_started      { runId, parentRunId, scope, toolSet }
child_run_progress     { runId, turn, toolCalls, status }
child_run_completed    { runId, summary, toolResults }
child_run_failed       { runId, error, category }
mesh_joined            { peerId, capabilities, deviceInfo }
mesh_left              { peerId, reason }
approval_requested     { runId, toolName, input, risk }
cancellation_propagated { runId, source, targetRuns }
```

### B.2 Mesh 协议补全
**当前状态**: `packages/dmoss-agent/src/mesh/agent-mesh.ts` (352 行) 已有 `query/response/announce`，`share_skill/share_memory` 落到 `default` 分支返回 "unknown message type"。

- 实现 `share_skill` / `share_memory` 处理器
- Mesh 节点身份验证（共享密钥 / token）
- 消息加密（NaCl box 或 TLS）

### B.3 子智能体编排运行时

**当前状态**: `spawn-profile.ts` (172 行) 定义 6 种 scope + 工具集，但无 spawn runtime。

- 子智能体上下文隔离：独立 system prompt、受限工具集、独立会话
- 父子通信协议：task → child / summary → parent
- fan-out：多子智能体并行派发 → result aggregation
- sequential pipeline：前一个输出作为后一个输入
- 超时 & 预算控制：单子智能体最长时间/轮次限制

### B.4 子智能体集成测试
- fan-out: 3 个子智能体同时搜索不同文件 → 合并结果
- pipeline: search → read → summarize 链式传递
- 超时: 子智能体挂起 → 父智能体正确 recovery
- 事件完整性: 验证所有 child_run_* 事件按正确顺序发射

---

## C — 基础代码搜索（Phase 6 精简版）

> Tree-sitter AST 工具整体移入 Phase 7。Phase 6 只做 grep 级搜索。

### C.1 `search_code` 工具（grep-based, 1-2 天）
**当前状态**: `builtin.ts` 的 `search_files` 仅支持 glob 文件名匹配。

- 正则/文本内容搜索 + 文件类型过滤
- 遵守 `.gitignore` / 通用 ignore 规则
- 安全边界：只在允许 workspace 内运行，不索引 secrets/logs/sessions/node_modules
- 大仓库保护：文件数上限、单文件大小上限、总搜索超时

---

## D — E2E 场景测试体系 (3-4 天)

### D.1 可回放测试素材

给 RDK Studio（和所有宿主）提供无设备可运行的测试素材：

- **Mock host**: 不依赖真实 LLM / SSH / 设备的完整 mock
- **Mock tool responses**: 固定的、确定性的工具输出
- **固定 LLM transcript**: 录制一次真实 agent loop → 回放加速 CI
- **Golden event stream**: 每个场景的期望事件序列
- **Golden final answer**: 每个场景的期望最终回答

### D.2 三个代表性场景

**场景 1 — Device Diagnostics**
```
用户: "诊断 RDK X5 设备状态"
Agent: SSH 连接 → 执行诊断命令 → 汇总传感器/CPU/内存 → 给出建议
Mock: 固定 SSH 输出 + 固定诊断 JSON
```

**场景 2 — Code/Workspace Modification**
```
用户: "读取 package.json 并更新版本号到 1.0.0"
Agent: read_file → 编辑 → lint/build 验证 → 报告结果
Mock: 本地文件系统，无需网络
```

**场景 3 — Documentation/Knowledge Lookup**
```
用户: "查一下 RDK Studio 的 Host Adapter 有哪些 capability"
Agent: knowledge 检索 → 文档摘要 → 引用原文
Mock: 固定 knowledge base
```

### D.3 回归护栏
- PR 前必须通过全部 3 个场景测试
- 场景失败自动生成 diff 报告（本次 golden vs 上次 golden）
- CI 矩阵中同时跑 mock 模式和真实 LLM 模式（可选）

---

## E — Observability + 发布工程 (3-4 天)

### E.0 默认脱敏层 🔴 安全前置
**原则: tracing 默认不采集敏感数据。宿主显式 opt-in 才放开。**

- 默认 redact: prompt 内容、工具参数、设备 IP、token、文件内容、API key
- 宿主通过 `DMOSS_TELEMETRY_ALLOW` 配置哪些字段可采集
- Redaction 发生在 exporter 层——span 内部不存明文

### E.1 OpenTelemetry Tracing
- Agent loop 全链路 span：每个 turn / tool call / LLM request / compaction
- Context 预算变化 trace：pruning/compaction 触发时的 token/char 变化
- Tool 执行延迟 histogram
- Child run span 关联到 parent（mesh 场景）

### E.2 LLM 使用面板
- 每 session 的 token 消耗 / 费用估算
- 模型级别成功率 / 平均延迟
- `DMOSS_TELEMETRY_EXPORT` 控制导出目标（stdout / OTLP endpoint / file）

### E.3 发布流水线
- `.github/workflows/ci.yml` 扩展：
  - 矩阵测试：macOS (arm64) + Linux (x64)
  - `npm run verify` → lint → typecheck → unit → integration → e2e smoke
- `npm version` + 自动化 changelog 生成（from conventional commits）
- npm publish 灰度：先 `@dmoss/core` → 等 CI 绿 → `@dmoss/agent` → 其他包

---

## Phase 7 预告（Tree-sitter 代码理解层）

从 Phase 6 移入，需要更多时间和独立的 WASM 工具链规划：

- tree-sitter WASM 编译 + Node.js binding
- `find_symbol` / `find_references` AST 级工具
- AST diff（比纯文本 diff 精准的修改检测）
- 安全边界（与 C.1 一致）：workspace 限定、ignore 遵守、大仓库保护

---

## 执行顺序

```
Week 1:   A.1 + A.2 (合约产物 + conformance 测试) ── 唯一天花板
Week 1:   B.0 (spawn-profile bug 修复) + C.1 (grep search_code) ── 并行快赢
Week 2:   A.3 + A.4 (fixture host + RDK Studio 对接)
Week 2:   B.1 + B.2 (mesh 事件协议 + 协议补全) ── 并行
Week 3:   B.3 + B.4 (子智能体编排 + 集成测试) ── 并行 ── D.1 + D.2 (E2E 素材 + 场景)
Week 3-4: E.0 + E.1 + E.2 + E.3 (脱敏 → tracing → 面板 → 发布)
```

### 关键决策

| 决策 | 原因 |
|------|------|
| Host Adapter 独占 Week 1 | Opus: "lock host adapter first, block everything else on this" |
| Tree-sitter 移入 Phase 7 | Opus + Sonnet 共识: 高不确定性、WASM 工具链风险、可被 grep 覆盖 80% |
| B.0 spawn-profile 前置修复 | Opus 发现的全局状态 bug——不修会导致并发子智能体互相污染 |
| E2E 补 mock/golden | RDK Studio 需求: CI 和无设备环境可运行 |
| Observability 默认脱敏 | RDK Studio 安全需求: prompt/token/IP 不可默认泄露 |

每个 P 级子任务完成后都必须跑 `npm run verify`。每周五做一次全量 verify + 手动场景冒烟。