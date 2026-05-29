# D-Moss Agent — 文件归属映射

本文档定义 `server/agent/` 和 `server/dmoss/` 中每个文件的归属（D-Moss 框架 vs RDK Studio 产品），
作为后续迁移的权威指南。当 D-Moss 作为独立仓库发布时，按此映射拆分。

## 解耦进度

### 已完成
- ✅ `@rdk-moss/agent` 包无 RDK/OpenClaw 品牌硬编码（品牌中立）
- ✅ `@rdk-moss/agent` 通过 `@rdk-moss/core` 正式包依赖（非相对路径）
- ✅ 受保护路径、工具截断阈值等可由宿主通过 `registerProtectedPaths()` / `registerToolOutputLimits()` 注入
- ✅ 环境变量统一使用 `DMOSS_*` 前缀（移除 `RDKCLAW_*` 回退）
- ✅ 所有 "对应 OpenClaw" 历史注释已清理
- ✅ Studio 侧通过 `dmoss-agent-bridge.ts` 的 `initStudioDmossBridge()` 统一注册 RDK 特有配置
- ✅ `inline-thinking-stream.ts` 迁移到 `@rdk-moss/agent/core`
- ✅ `sandbox-paths.ts` 迁移到 `@rdk-moss/agent/safety`
- ✅ `context-window-guard.ts` 迁移到 `@rdk-moss/agent/context`
- ✅ `shell-soft-failure-hint.ts` 迁移到 `@rdk-moss/agent/safety`
- ✅ `server/dmoss/` → `server/agent/` 交叉引用中已迁移模块改用 `@rdk-moss/agent` 包路径

- ✅ `PiAiLLMProvider` 适配器（pi-ai → LLMProvider 接口），可独立使用 DmossAgent
- ✅ `JsonlSessionStore` 持久化实现（JSONL 文件存储）
- ✅ `dmoss-agent-bridge.ts` 导出 PiAiLLMProvider/JsonlSessionStore
- ✅ 核心编排迁移：`DmossAgent.streamChat()` 已固定委派到唯一主循环 `runAgentLoop`；旧 inline loop 与回滚开关已移除
- ✅ DmossAgent 功能已完成：pruning, compaction, thinking stream, steering, follow-up, context window guard 等均已集成到框架

### 待完成
- 🔄 `provider-setup.ts`、`provider-defaults.ts`、`model-registry.ts` 等 Studio 侧配置管理尚在 `server/agent/`

## 状态说明

- ✅ **已迁移** — 代码已在 `packages/dmoss-agent/src/`，server/ 为 re-export
- 🔄 **待迁移** — 应属于 D-Moss，但尚未物理搬迁
- 🏠 **Studio** — 属于 RDK Studio 产品，不随 D-Moss 发布

---

## `server/agent/` → D-Moss

| 文件 | 状态 | D-Moss 目标路径 | 说明 |
|------|------|----------------|------|
| `agent-loop.ts` | ✅ | `core/agent-loop.ts` | Agent 主循环，已迁移 |
| `agent.ts` | 🏠 | — | Studio Agent 类（保留在宿主，组装 Studio 特有功能） |
| `session.ts` | ✅ | `core/session-jsonl.ts` | JSONL 会话管理 |
| `session-write-lock.ts` | ✅ | `core/session-write-lock.ts` | 写锁 |
| `agent-events.ts` | ✅ | `core/agent-events.ts` | MiniAgentEvent 类型与 EventStream |
| `message-convert.ts` | 🏠 | — | Studio 侧消息转换（保留） |
| `inline-thinking-stream.ts` | ✅ | `core/inline-thinking-stream.ts` | 思考过程解析 |
| `tool-pipeline.ts` | ✅ | `core/tool-pipeline.ts` | 工具前置钩子与输入校验 |
| `tool-hooks.ts` | ✅ | `core/tool-hooks.ts` | 工具后置钩子 |
| `compact-hooks.ts` | ✅ | `core/compact-hooks.ts` | 压缩钩子 |
| `memory.ts` | ✅ | `core/memory.ts` | MemoryManager |
| `command-queue.ts` | ✅ | `core/command-queue.ts` | 命令队列 |
| `context/index.ts` | ✅ | `context/index.ts` | 上下文管理导出 |
| `context/pruning.ts` | ✅ | `context/pruning.ts` | 上下文裁剪 |
| `context/compaction.ts` | ✅ | `context/compaction.ts` | 上下文压缩 |
| `context/loader.ts` | ✅ | `context/loader.ts` | Bootstrap 上下文加载 |
| `context/microcompact.ts` | ✅ | `context/microcompact.ts` | 微压缩 |
| `context/window-economics.ts` | ✅ | `context/window-economics.ts` | 窗口经济学 |
| `context/tool-output-truncate.ts` | ✅ | `context/tool-output-truncate.ts` | 工具输出截断 |
| `context/tokens.ts` | ✅ | `context/tokens.ts` | Token 计数 |
| `provider/index.ts` | ✅ | `provider/index.ts` | pi-ai re-export |
| `provider/errors.ts` | ✅ | `provider/errors.ts` | 错误分类与重试 |
| `provider-setup.ts` | 🏠 | — | Studio Provider 配置（保留在宿主） |
| `provider-defaults.ts` | 🏠 | — | Studio 默认配置加载（保留在宿主） |
| `model-registry.ts` | 🏠 | — | Studio 模型能力注册（保留在宿主） |
| `spawn-profile.ts` | 🏠 | — | Studio 子代理配置（保留在宿主） |
| `tools/types.ts` | ✅ | `core/tool-types.ts` | 工具类型（通用部分） |
| `tools/abort.ts` | ✅ | `core/abort.ts` | AbortController 工具 |
| `plugins/dmoss-plugin-types.ts` | ✅ | _(in @rdk-moss/core)_ | 已通过 re-export |
| `sandbox-paths.ts` | ✅ | `safety/sandbox-paths.ts` | 沙箱路径校验 |
| `session-key.ts` | ✅ | `core/session-key.ts` | 会话 Key 生成 |

## `server/agent/` → Studio（不随 D-Moss 发布）

| 文件 | 说明 |
|------|------|
| `cli.ts` | Studio CLI 入口（绑定 Studio 特有命令） |
| `sdk.ts` | Studio SDK 入口 |
| `channels/weixin.ts` | 微信通道适配 |
| `channels/feishu.ts` | 飞书通道适配 |
| `gateway/` | 网关相关 |
| `openclaw-index.ts` | OpenClaw 模块桶文件 |
| `dmoss-tool-hooks.ts` | Studio 特有工具钩子 |
| `tools/device-tools.ts` | Studio 设备工具实现 |
| `tools/studio-tools.ts` | Studio 专有工具 |
| `tools/attachment-tools.ts` | Studio 附件工具 |

## `server/dmoss/` → D-Moss

| 文件 | 状态 | 说明 |
|------|------|------|
| `secret-sanitizer.ts` | ✅ | 密钥脱敏 |
| `channel-safety.ts` | ✅ | 安全检测（通用部分已迁移） |
| `text-delta-smoother.ts` | ✅ | 流式平滑 |
| `run-trace-log.ts` | ✅ | 结构化日志 |
| `system-prompt-telemetry.ts` | ✅ | 提示遥测 |
| `max-agent-turns.ts` | ✅ | 轮次限制 |
| `delegation.ts` | 🏠 | 委派路径决策（Studio 特有） |
| `permission-guard.ts` | 🏠 | 权限守卫（Studio 特有） |
| `at-ref-parser.ts` | ✅ | @引用解析 |
| `skills/registry.ts` | ✅ | 技能注册表 |
| `shell-soft-failure-hint.ts` | ✅ | Shell 软失败提示 |
| `robotics-engineering-prompt.ts` | ✅ | 已迁移到 `@rdk-moss/agent/prompts` |
| `system-prompt-layers.ts` | 🏠 | 提示分层（Studio 特有） |
| `types.ts` | 🏠 | 请求/附件/策略类型（Studio 特有） |

## `server/dmoss/` → Studio

| 文件 | 说明 |
|------|------|
| `app.ts` | Studio 编排器（消费 DmossAgent） |
| `open-web-intent.ts` | 打开网页意图与 `studio_open_url` 提示路由（宿主能力，非 `@rdk-moss/agent`） |
| `system-prompt-builder.ts` | Studio 专有提示内容 |
| `tool-contract-prompt.ts` | Studio 工具描述 |
| `notification-hub.ts` | Socket.IO 推送 |
| `persona-store.ts` | 人格持久化 (.rdkstudio) |
| `policy-store.ts` | 策略持久化 (.rdkstudio) |
| `workspace-store.ts` | 工作区管理 |
| `autonomy-scheduler.ts` | 自治任务 |
| `weixin-*.ts` | 微信相关（全部） |
| `feishu-*.ts` | 飞书相关（全部） |
| `forum-*.ts` | 论坛相关 |
| `rdk-doc-*.ts` | RDK 文档索引 |
| `openclaw-*.ts` | OpenClaw 管理 |
| `board-*.ts` | 板端编排 |
| `device-*.ts` | 设备管理 |
| `command-semantics.ts` | RDK 命令语义 |
| `queue-status-format.ts` | 渠道文案 |

## `server/knowledge-modules/` → D-Moss

| 文件 | 状态 |
|------|------|
| `registry.ts` | ✅ |
| `types.ts` | ✅ (re-export from @rdk-moss/core) |
| `index.ts` | 🏠 Studio（编排入口，调用 bootstrap + robot-hub 加载） |
| `robot-hub-store.ts` | 🏠 Studio（文件系统持久层，依赖 `resolveDataDir()`；类型已从 `@rdk-moss/agent/knowledge` 导入） |
| `robot-hub-types.ts` | ✅ 已迁移至 `@rdk-moss/agent/knowledge/robot-hub-types.ts`（Studio 侧为 re-export） |

## `server/dmoss-extensions/` → D-Moss（框架部分）

| 文件 | 状态 |
|------|------|
| `platform-extension-registry.ts` | ✅ (抽象版) |
| `platform-extension-catalog.ts` | ✅ |
| `dmoss-platform-extension.ts` | ✅ (宿主绑定) |
| `bootstrap.ts` | ✅ (框架在 agent，Studio 注册工厂) |
| `extension-device-tools.ts` | 🏠 Studio（依赖 Studio Tool 类型与厂商插件注册表） |
| `builtins/rdk-studio-platform-extension.ts` | 🏠 Studio |

---

**统计**: ✅ 已迁移 ~42 | 🏠 Studio 保留 ~33 | 🔄 待迁移 0

## 宿主集成 API

当 `@rdk-moss/agent` 作为独立开源包时，宿主（如 RDK Studio）通过以下 API 注入产品特有配置：

| API | 用途 | Studio 调用位置 |
|-----|------|----------------|
| `registerProtectedPaths(paths)` | 注册产品特有受保护路径 | `dmoss-agent-bridge.ts` |
| `registerToolOutputLimits(limits)` | 注册产品工具截断阈值 | `dmoss-agent-bridge.ts` |
| `registerMutatingToolHints({ exact, prefixes })` | 声明宿主工具名/前缀为「有副作用」，参与幂等重放判断 | `dmoss-agent-bridge.ts` |
| `setOpenUrlMarkers({ successMarker, failurePattern })` | 打开 URL 工具成功/失败文案，用于抑制重复 `web_fetch` | `dmoss-agent-bridge.ts` |
| `registerSpawnToolExtensions(...)` | 子代理可调用工具名扩展 | `dmoss-agent-bridge.ts` |
| `registerNonMainChannelPrefixes(...)` | 非主会话渠道前缀 | `dmoss-agent-bridge.ts` |
| `setVendorPluginCallbacks(cbs)` | 对接厂商插件系统 | `dmoss-agent-bridge.ts` |
| `registerKnowledgeModule(mod)` | 注册领域知识模块 | `register-rdk-studio-module.ts` |
| `syncPlatformExtensionsAtStartup()` | 启动时同步平台扩展 | `bootstrap.ts` |

核心 Agent 运行时已基本完成迁移。剩余 🏠 标记文件属于 Studio 产品层，不随 `@rdk-moss/agent` 发布。
