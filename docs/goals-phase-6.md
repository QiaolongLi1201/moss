# Moss Phase 6 目标

> 生成时间: 2026-05-23
> 前置: Phase 5 (P0安全/P1架构/P2测试/P3可扩展) 全部完成
> 预计: 12-17 天

---

## A — Host Adapter v1 正式合约 (3-5 天)

### A.1 合约版本化 & 协商
**当前状态**: `MOSS_HOST_ADAPTER_CONTRACT_VERSION = 1` 已定义，`evaluateMossHostCompatibility()` 已实现 semver 检查。
**文件**: `packages/dmoss/src/contracts/host-adapter.ts`

- 定义 v1 合约冻结范围（哪些接口 stable / 哪些 evolving / 哪些 experimental）
- 合约版本与运行时版本解耦协商：宿主声明 `minContractVersion` + `maxContractVersion`
- 合约破坏性变更检测工具：对比两个合约版本的 diff → 自动生成 migration guide
- 降级路径：宿主未实现可选能力时的 fallback 策略文档化

### A.2 兼容性测试体系
- `evaluateMossHostCompatibility()` 的单元测试：覆盖 6 种 failure mode
- 构建标准 fixture manifest 作为参考实现模板
- manifest schema 验证（Zod 或手写 validator）

### A.3 最小 CLI 宿主
- `packages/create-dmoss-app/` 产出可运行的 minimal host
- 仅依赖 `@dmoss/agent` + `@dmoss/core`，不引 RDK Studio 代码
- 作为合约验收的独立参照点：能用它跑通一轮 agent 对话 = 合约合格

### A.4 RDK Studio 对接
- RDK Studio 侧 `moss:update` 通过 → 记录宿主适配器变更清单
- 确认所有 capability kind 至少有一个宿主实现

---

## B — Agent Mesh 多智能体协作 (2-3 天)

### B.1 Mesh 协议补全
**当前状态**: `packages/dmoss-agent/src/mesh/agent-mesh.ts` (352 行) 已有 `query/response/announce` 三种消息处理，`share_skill/share_memory` 声明但未实现。
**文件**: `packages/dmoss-agent/src/mesh/`

- 实现 `share_skill` 处理器：节点间交换已验证 skill
- 实现 `share_memory` 处理器：节点间交换 memory 摘要
- Mesh 节点身份验证（共享密钥 / token）
- 消息加密（TLS or NaCl box）

### B.2 子智能体编排
**当前状态**: `packages/dmoss-agent/src/core/spawn-profile.ts` (172 行) 定义了 6 种 spawn scope 和工具集。
**文件**: `packages/dmoss-agent/src/core/`

- 子智能体上下文隔离：独立 system prompt、受限工具集、独立会话
- 父子通信协议：summary → parent / task → child
- 并发编排：fan-out（多子智能体并行派发）→ result aggregation
- sequential pipeline：前一个子智能体的输出作为后一个的输入
- 超时 & 预算控制：单子智能体最长时间/轮次限制

### B.3 子智能体集成测试
- fan-out 场景：3 个子智能体同时搜索不同文件 → 合并结果
- pipeline 场景：search → read → summarize 链式传递
- 超时场景：子智能体挂起 → 父智能体正确 recovery

---

## C — Tree-sitter 代码理解层 (2-3 天)

### C.1 Parser 基础设施
**当前状态**: `external/tree-sitter/` 已作为 submodule 引入，无集成代码。
**文件**: 新建 `packages/dmoss-agent/src/code-intel/`

- tree-sitter WASM 编译脚本 + Node.js binding wrapper
- 语言 grammar 注册系统（TypeScript/JavaScript/Python/C++ 首批）
- LRU parser 缓存：按文件路径缓存编译后的 tree

### C.2 代码搜索工具
**当前状态**: `builtin.ts` 的 `search_files` 仅支持 glob 文件名匹配，无内容/AST 搜索。

- `search_code` 工具：正则/文本内容搜索 + 文件类型过滤
- `find_symbol` 工具：tree-sitter query 提取函数/类/接口定义
- `find_references` 工具：跨文件符号引用分析
- AST 级 diff 工具：比纯文本 diff 更精准的修改范围检测

### C.3 知识/技能模块受益
- skill distiller 利用 AST 理解工具输出中的代码结构
- memory 利用符号索引做更精准的 long-term recall
- teaching annotation 关联到具体代码符号

---

## D — E2E 场景测试体系 (2-3 天)

### D.1 测试基础设施
- `@dmoss/agent` 统一测试入口：`node --test test/*.spec.mjs`
- 测试 fixture pool：临时目录、mock LLM provider、mock session store
- 场景录制/回放：录制一次真实 agent loop 的 LLM 响应 → 回放加速 CI

### D.2 三个代表性场景

**场景 1 — Device Diagnostics**
```
用户: "诊断 RDK X5 设备状态"
Agent: SSH 连接 → 执行诊断命令 → 汇总传感器/CPU/内存 → 给出建议
```

**场景 2 — Code/Workspace Modification**
```
用户: "读取 package.json 并更新版本号到 1.0.0"
Agent: read_file → 编辑 → lint/build 验证 → 报告结果
```

**场景 3 — Documentation/Knowledge Lookup**
```
用户: "查一下 RDK Studio 的 Host Adapter 有哪些 capability"
Agent: knowledge 检索 → 文档摘要 → 引用原文
```

### D.3 回归护栏
- PR 前必须通过全部 3 个场景测试
- 场景失败自动生成 diff 报告（上次成功 vs 本次失败）

---

## E — Observability + 发布工程 (2-3 天)

### E.1 OpenTelemetry Tracing
- Agent loop 全链路 span：每个 turn / tool call / LLM request / compaction
- Context 预算变化 trace：pruning/compaction 触发时的 token/char 变化
- Tool 执行延迟 histogram

### E.2 LLM 使用面板
- 每 session 的 token 消耗 / 费用估算
- 模型级别成功率 / 平均延迟
- `DMOSS_TELEMETRY_EXPORT` 环境变量控制导出目标（stdout / OTLP endpoint / file）

### E.3 发布流水线
- `.github/workflows/ci.yml` 扩展：
  - 矩阵测试：macOS (arm64) + Linux (x64)
  - `npm run verify` → lint → typecheck → unit → integration → e2e smoke
- `npm version` + 自动化 changelog 生成（from conventional commits）
- npm publish 灰度：先 `@dmoss/core` → 等 CI 绿 → `@dmoss/agent` → 其他包

---

## 执行顺序

```
Week 1:   A.1 + A.2 (合约冻结 + 测试) ──── 并行 ──── C.1 + C.2 (tree-sitter 基础设施)
Week 2:   A.3 + A.4 (minimal host + RDK 对接) ── 并行 ── B.1 (mesh 协议补全)
Week 2-3: B.2 + B.3 (子智能体编排 + 测试) ── 并行 ── D.1 + D.2 (场景测试体系)
Week 3:   E.1 + E.2 + E.3 (observability + 发布)
```

每个 P 级子任务完成后都必须跑 `npm run verify`。每周五做一次全量 verify + 手动场景冒烟。