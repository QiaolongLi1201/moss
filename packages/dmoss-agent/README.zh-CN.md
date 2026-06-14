# @rdk-moss/agent

[English](README.md) · **简体中文**

> **Moss Agent 运行时。** 安装 `moss` 即可使用终端 Agent，或 `npm install` 把一个面向机器人的 Agent——工具循环、上下文治理、安全钩子、会话、可插拔知识——嵌入你自己的产品。

由 地瓜机器人 (D-Robotics) 打造。项目是 **Moss**；包是 **`@rdk-moss/agent`**；CLI 是 **`moss`**（`dmoss` 为兼容别名）。

<p align="center">
  <a href="#安装"><img src="https://img.shields.io/npm/v/@rdk-moss/agent?logo=npm&color=ff6b00" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.16-brightgreen?logo=node.js&logoColor=white" alt="node >= 22.16" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT" />
  <img src="https://img.shields.io/badge/provider-agnostic-8a67f6" alt="provider-agnostic" />
</p>

<p align="center">
  <img src="./assets/moss-tui-demo.gif" alt="Moss 终端启动演示" width="720" />
</p>

这个包同时是两样东西：

- **一个终端 Agent**——`npm i -g @rdk-moss/agent`，运行 `moss`，在内置 D-Robotics 网关上即刻开干（无需模型 Key、无需强制登录）。
- **一个可嵌入运行时**——`npm install @rdk-moss/agent @rdk-moss/core`，然后用你自己的 服务商、工具、存储与审批策略驱动 `DmossAgent`。

> **不只是 LLM 包装。** 这套 harness 拥有工具循环、上下文裁剪/压缩、安全/审批钩子、会话持久化、结构化错误与重试，以及可插拔的 `KnowledgeModule`——让你的应用专注于设备、UX 与策略。稳定公开面是 `packages/dmoss/` + `packages/dmoss-agent/`；宿主在其上构建的一切（HTTP 服务、桌面外壳、SSH 桥接）都在本包 API 之外。

## 安装

需要 **Node ≥ 22.16**。

```bash
npm i -g @rdk-moss/agent@latest    # CLI
# 或
npm install @rdk-moss/agent@latest @rdk-moss/core@latest   # 嵌入
```

## 使用 CLI

```bash
moss                       # 内置网关上的交互式 TUI
moss "看看磁盘占用"          # 一次性
moss setup                 # 配置自己的 服务商 / 模型 / Key
```

完整 CLI 指南——模型配置、连接开发板、长程任务、自动化、安全与技能——见[项目 README](../../README.zh-CN.md)。核心几条：

```bash
moss resume --last         # 继续最近一次已保存会话
moss --session work        # 继续或创建命名会话
moss doctor                # 体检配置、认证、工作区、开发板、MCP（失败时退出码非零）
moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data
```

`/connect <ip>` 通过 SSH 把活动会话搬到 RDK 板上（板端模式：设备 + ROS2 工具），`/disconnect` 恢复本地工具。在 RDK 板上，用 [device-knowledge](https://github.com/D-Robotics/device-knowledge) 知识包把整套栈教给 Moss——见[给 Moss 装上 RDK 板端 Skill](../../README.zh-CN.md#给-moss-装上-rdk-板端-skill)。

最常用的会话内命令（输入 `/help` 查看全部）：

```
/status /model              模型、工作区、设备与工具状态 · 选择模型
/connect /disconnect        连接 RDK 板并进入板端模式 · 退出
/sessions /resume           列出已保存会话 · 切换进某个会话（[key|--last]）
/goal /compact /attach      目标运行器 · 压缩历史 · 附加图片/文件
/mcp /doctor /diff /yolo    MCP 状态 · 体检 · 改动 · 全权会话
```

## 嵌入运行时

只需实现一个接口——`LLMProvider`——即可驱动 Agent。为了最小接口面与完全掌控，可只用 `fetch()` 自己实现（无需 Anthropic/OpenAI SDK）；`PiAiLLMProvider` 是给已使用 pi-ai 风格流的宿主的可选便利桥接。

```typescript
import { DmossAgent, InMemorySessionStore } from '@rdk-moss/agent';
import type { LLMProvider } from '@rdk-moss/agent';

const myProvider: LLMProvider = { /* 调用你的模型（fetch 足矣） */ };

const agent = new DmossAgent({
  llmProvider: myProvider,
  sessionStore: new InMemorySessionStore(),
  model: 'claude-sonnet-4-20250514',
  hooks: {
    onBeforeToolExec: async (req) => ({ approved: true }),  // 你的审批策略
    onToolResult: (call, result) => auditLog(call, result),
  },
});

// 为你的平台注册工具与硬件知识。
agent.tools.register({
  name: 'device_exec',
  description: 'Execute a command on the connected device',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  execute: async (input) => { /* ... */ },
});

const result = await agent.chat('session-1', 'Check the camera status', { platform: 'my-board-v1' });
console.log(result.response);
```

实时 UI 则改用流式事件：

```typescript
for await (const event of agent.streamChat('session-1', 'Check camera')) {
  if (event.type === 'text_delta') process.stdout.write(event.delta);
  if (event.type === 'tool_start') console.log(`tool: ${event.toolName}`);
  if (event.type === 'done') console.log(`\n${event.result.toolCalls.length} tool calls`);
}
```

### 核心 API 面

| 在宿主中实现 | 作用 |
| --- | --- |
| `LLMProvider` | `DmossAgent` 调用模型唯一需要的契约 |
| `SessionStore` | 会话持久化（文件、数据库、内存） |
| `AgentHooks` | 生命周期钩子：审批、审计、事件、上下文增强 |
| `KnowledgeModule`（`@rdk-moss/core`） | 某硬件平台的设备画像、提示词、命令模式与故障提示 |

| 从运行时取用 | 作用 |
| --- | --- |
| `DmossAgent` | 中枢编排器：对话循环、工具执行、钩子、目标状态 |
| `ToolRegistry` | 注册 / 发现 / 分组工具 |
| `InMemorySessionStore` | 内置会话存储 |
| `SkillRegistry` | `SKILL.md` 扫描器 |

`DmossAgent` 还为每个会话跟踪一个**目标**（`setGoal` / `pauseGoal` / `completeGoal` / `blockGoal` / `clearGoal`）并注入系统提示；`moss` CLI 的 `/goal` 运行器就建立在该状态上。子路径 `@rdk-moss/agent/goal`、`/observability`、`/mesh` 分别暴露目标适配器、追踪/脱敏辅助与 mesh 事件总线。

完整公开面——每个类型、事件与导入建议——见 [`API.md`](./API.md)，扩展用法见 [`USAGE.md`](./USAGE.md)。

## 诚实的运行时行为

每次运行都会向系统提示注入一层精简的能力声明：本次实际注册的工具名（让模型用真实工具而非猜测）、按实际注册情况得出的 MCP/CodeGraph 状态（仅当存在 `codegraph_*` 工具时才推荐 CodeGraph），以及一份实事求是的行为契约——区分已验证事实、推断与假设，证据缺失时如实说明，绝不在没有检查支撑时声称结果。

## 配置你自己的模型

```bash
moss config set provider openai-compatible
moss config set model <你的模型>
moss config set baseUrl https://llm.example.com   # API 根地址，不要带 /chat/completions
moss setup                                          # 存储 Key（隐藏输入）
```

支持：`deepseek`、`qwen`、`openai`、`anthropic`、`openai-compatible`。设置只存在 moss 配置里——`OPENAI_API_KEY` / `DMOSS_PROVIDER` 等环境变量被刻意忽略，这样为别的工具导出的 Key 不会悄悄切换你的服务商（`moss doctor` 会列出残留）。脚本/CI 用 `moss --config-file /path/to/config.json`。优先级：CLI 参数 / `-c key=value` > 项目 `.moss/config.json` > `moss config` > 内置网关。

## 从源码运行

```bash
git clone https://github.com/D-Robotics/moss && cd moss
npm install
npm run build -w @rdk-moss/agent
node packages/dmoss-agent/dist/cli.js   # 源码 checkout 不含私有的零配置网关文件；请运行 `setup` 或设置自己的服务商。
```

维护者用 `npm run verify`（OSS 边界 + 卫生检查、构建、类型检查、lint、测试）与 `npm run smoke:moss-cli`（打包 tarball、装入临时项目、检查 bin 与打包资源）验证发布。

## API 稳定性

稳定面是 `package.json` 的导出映射，记录于 [`API.md`](./API.md)。宿主级路由与产品集成属于嵌入应用，不属于本包公开 API。标注 `/** @internal */` 的导出是实现细节——不受 semver 保护，任意版本都可能变更。请优先使用 [`API.md`](./API.md) 中记录的接口面。

## 文档

- [`API.md`](./API.md) —— 稳定公开 API、事件模型、导入建议
- [`USAGE.md`](./USAGE.md) —— 扩展用法与宿主集成模式
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) —— 本包贡献指南
- [`SECURITY.md`](./SECURITY.md) —— 漏洞报告与安全范围
- [`CHANGELOG.md`](./CHANGELOG.md) —— 发布历史

## 许可证

[MIT](./LICENSE)
