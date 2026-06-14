# Moss

[English](README.md) · **简体中文**

**一个开箱即用、面向机器人的终端 Agent，同时也是可嵌入的 Agent 运行时。** 由 地瓜机器人 (D-Robotics) 打造。

运行 `moss`，提问，开干。无需 API Key、无需强制登录——首次启动就已接入内置的 D-Robotics 网关。想用自己的模型、计费或私有端点时，把 Moss 指向任意 OpenAI 兼容或 Anthropic 服务即可，Agent 本身不变。`/connect` 一块 RDK 开发板，整个会话就通过 SSH 搬到板子上运行。

> `moss` 是主命令；`dmoss` 作为兼容别名保留。

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-tui-demo.gif" alt="Moss 终端启动演示" width="720" />
</p>

## 快速开始

```bash
npm i -g @rdk-moss/agent@latest   # 需要 Node 22.16+
moss
```

首次启动即可在内置网关上工作——直接提问就有回答，无需 Key、无需登录。

```bash
moss "看看这个项目的磁盘占用"          # 一次性：回答后退出
echo "列出失败的测试" | moss           # 管道 stdin
moss -m qwen-plus "总结 @README.md"    # 临时覆盖模型；@路径 可附加文件
```

随时用 `npm i -g @rdk-moss/agent@latest` 更新，或在 Moss 内输入 `/upgrade`。

## 为什么选 Moss

还是你熟悉的 Claude Code / Codex 终端循环，但所有权模型不同：

- **零配置起步**——内置 D-Robotics 网关，无需模型 Key，无需强制登录。
- **自带模型** ——DeepSeek、Qwen、任意 OpenAI 兼容网关、Anthropic 或自托管模型。切换服务商从不改变 Agent。
- **原生面向机器人与开发板**——`/connect <ip>` 让会话通过 SSH 跑在 RDK 板上，带诊断与 ROS2 工具；再用 [device-knowledge](https://github.com/D-Robotics/device-knowledge) 的 Skill 把整套 RDK 知识教给它。
- **扛得住长程、可中断的任务**——会话自动保存，工作上下文检查点记录当前任务，`moss resume` 接着干而不是从零重来。
- **诚实可信**——区分已验证事实、推断与假设，能力不可用时如实上报，从不声称未经检查的结果。
- **可嵌入**——它是带公开契约和 npm 包的运行时，而不仅是一个独立 App。

## 日常使用

在项目里启动 Moss，然后用自然语言驱动它。输入 `/help` 查看完整命令；最常用的几个：

| 命令 | 作用 |
| --- | --- |
| `/status` · `/model` | 显示模型/登录/工作区/板端状态 · 切换当前模型 |
| `/connect <ip>` · `/disconnect` | 进入 / 离开 RDK 设备的板端模式 |
| `/resume [key\|--last]` · `/sessions` | 切换到某个已保存会话 · 列出会话 |
| `/goal <条件>` | 持续运行直到达成目标条件（goal runner） |
| `/attach <路径>` · `/diff` · `/review` | 附加图片/文件 · 查看改动 · 审查改动找 bug |
| `/skills` · `/memory` · `/mcp` · `/doctor` | 查看技能 · 记忆 · MCP 服务 · 体检本次运行 |
| `/compact` · `/clear` · `/yolo` | 压缩历史 · 新会话 · 全权会话（`/yolo off` 撤销） |

按 **Shift+Tab** 在交互模式间循环：`plan`（只读）、`default`（逐次审批）、`accept-edits`（自动批准工作区写入）。用 `@路径` 内联附加上下文（`总结 @README.md`），或 `/attach ./screenshot.png`；图片发给支持视觉的模型，文本文件作为提示上下文。

## 连接 RDK 开发板

在活动会话里直接 `/connect`，无需重启：

<p align="center">
  <img src="packages/dmoss-agent/assets/moss-connect-vision.gif" alt="Moss 板连接与图片附加演示" width="720" />
</p>

```text
/connect 192.168.1.10 --user root
/connect ubuntu@192.168.1.10 --port 2222 --key ~/.ssh/id_rsa
检查摄像头、ROS2 节点、磁盘空间和设备健康状况。
```

`/connect` 会先验证 SSH 可达性与凭据，再启用设备工具；探测失败会说明原因，工具保持禁用（`--no-verify` 跳过探测）。验证通过后会话进入**板端模式（board mode）**：默认工具（`exec`、`read_file`、`write_file`、`edit_file`、`list_directory`、`search_files` 等）通过 SSH 在板上执行，ROS2（`ros2_topic_list`、`ros2_node_list`、`ros2_service_call`、`ros2_launch` 等）与 `device_*` 诊断工具同时可用，并遵循板子配置的 `ROS_DOMAIN_ID`。用 `/disconnect`（或空提示符下 Ctrl+D）退出，本地工具原样恢复；`--hybrid` 则保留本地工具、只额外加上 `device_*` / `ros2_*`。SSH 凭据、审批策略与受保护路径始终由宿主掌控。

### 给 Moss 装上 RDK 板端 Skill

在 RDK 板上（或连接到板子时），Moss 懂 RDK 这套栈才最好用。开源的 [**device-knowledge**](https://github.com/D-Robotics/device-knowledge) 知识包就是一组 `SKILL.md`，Moss 可直接加载——指向它，Moss 操作板子时就会应用这些知识：

| Skill | 解锁什么 |
| --- | --- |
| `rdk-device` | 模型部署闭环（`.pt`/`.onnx` → `.bin` BPU 工具链）、首次开箱联网、摄像头/视觉推理 |
| `rdk-ros` | TROS/ROS2 环境初始化、`ros2` 命令、节点排障、双目深度/Livox 节点 |
| `rdk-peripheral-cookbook` | GPIO/I2C/SPI/UART、PWM 舵机、电机、LED/WS2812、音频（ALSA）、`libgpiod` |
| `rdk-board-knowledge` | 板型基线确认、报错诊断、55 条故障速查 |
| `rdk-hardware` · `rdk-ecosystem` | 40PIN GPIO、摄像头、BPU 流水线、散热、网络 · RDK 选型、模型可行性、跨平台对比 |
| `jetson-knowledge` · `rpi-knowledge` · `rk-knowledge` | Jetson、树莓派、Rockchip RK3588 的对应知识包 |

以下任一方式加载，然后用 `/skills` 确认：

```bash
# 1. 克隆到默认技能根目录（自动扫描，无需配置）：
git clone https://github.com/D-Robotics/device-knowledge ~/.agents/skills/device-knowledge

# 2. 或在 Moss 配置里指向知识包的 skills/ 目录：
#    在 moss config.json 中加入 →  "skills": { "extraRoots": ["/path/to/device-knowledge/skills"] }

# 3. 或直接在某个 checkout 内运行 Moss——它的 skills/ 目录会被自动发现。
```

这些 Skill 是知识与指令，不是板端二进制：它们让 Moss 在设备上行为正确，而凭据与审批仍归宿主所有。

## 长程任务与续跑

每次普通 `moss` 启动都是一个新的已保存会话；只有你主动要求时才会接续历史：

```bash
moss resume --last            # 继续最近一次会话
moss --session work           # 继续或创建一个命名会话
moss --continue "接着干"       # 一次性运行，自动续上最近会话
moss fork --last              # 复制一个分支，不影响原会话
```

运行过程中，Moss 维护当前任务的工作上下文检查点（目标、已完成/待办步骤、关键路径、近期发现）。一旦运行被打断——工具循环守卫触发、工具报错、或回合预算用尽——任务会被标记为**可续跑（resumable）**而非丢失：CLI 会告诉你它提前停了、以及如何继续，说 `continue` / `继续`（或 `/goal`）就从检查点续跑、不重复已完成的步骤。压缩历史时会保留目标与待办步骤，长任务因此不断线。

```text
/goal 把这个仓库迁移到新包名并验证构建
```

goal runner 会一直工作，直到目标完成、受阻、被清除或被停止。

## 使用你自己的模型

内置网关用于即时上手；当你需要自己的账号、计费、私有网关或自托管模型时，再配置自己的服务商。你的配置始终覆盖内置网关。

```bash
moss setup            # 交互式：选服务商 + 模型，粘贴 Key（隐藏输入）
moss auth status      # 显示解析出的服务商/模型/Key 来源
```

支持的服务商：`deepseek`、`qwen`、`openai`、`anthropic`、`openai-compatible`。私有网关示例：

```bash
moss config set provider openai-compatible
moss config set model <你的模型>
moss config set baseUrl https://llm.example.com   # API 根地址，不要带 /chat/completions
moss setup                                         # 存储 Key（隐藏输入）
```

模型设置只存在 moss 配置里——`OPENAI_API_KEY`、`DMOSS_PROVIDER` 等环境变量被刻意忽略，这样为别的工具导出的 Key 不会悄悄改变你的服务商（`moss doctor` 会列出这类残留变量）。优先级：CLI 参数 / `-c key=value` > 项目 `.moss/config.json` > `moss config` / `moss setup` > 内置网关。在 Moss 内用 `/model` 列出服务商模型或设置自定义模型。

## 自动化与安全

除非你选择更自主的策略，Moss 在文件写入、执行命令和外部动作前都会询问。交互式下，**Shift+Tab** 循环 `plan` / `default` / `accept-edits`，`/yolo` 授予全权会话（`/yolo off` 撤销）。无人值守启动时可预先设定策略：

```bash
moss --ask-for-approval workspace-write "编写并验证这个工具"
DMOSS_CLI_AUTO_APPROVE=1 moss -p "跑一遍基准测试"
```

`--ask-for-approval` 接受 `never`、`prompt`、`on-request`、`read-only`、`workspace-write`、`full-access`；未知值会被拒绝而非忽略。它们——以及 `DMOSS_CLI_AUTO_APPROVE=1`——都不会绕过 `--read-only`、`deniedTools`、受保护路径或危险命令底线。设备类变更（重启、板端 `rm`、`ros2_service_call` 等）从不被一揽子信任：选"总是"只批准当前这一次。用 `moss config set trustedTools/deniedTools <csv>` 按工具细分信任。无头运行中，被自动批准的变更类工具会在 stderr 留下一行 `[approval]` 审计记录。

运行 `moss doctor` 一次性体检 Node、版本、认证、服务商/模型、工作区、安全策略和 MCP；真正失败时退出码非零，可作为 CI 闸门。

## 技能、记忆与 MCP

Moss 会发现 `.moss/skills/`、`~/.agents/skills` 以及配置的 `skills.extraRoots` 下的 `SKILL.md`（见上文板端 Skill 一节）。内置工作流技能涵盖方法化构建、调试、测试驱动改动与迁移安全；`install_skill` 工具可经正常审批策略创建新的工作区技能，优质运行会沉淀为候选技能、用 `/skills` 审阅。长期记忆通过 `memory_read`/`memory_write`/`memory_delete` 工作，Moss 还会自动加载工作区根目录的 `USER.md`、`MEMORY.md`、`AGENTS.md`（用 `/memory` 查看）。

无需编辑 JSON 即可从 [Model Context Protocol](https://modelcontextprotocol.io) 服务加载工具：

```bash
moss mcp add fs npx -y @modelcontextprotocol/server-filesystem /data
moss mcp list
moss config set mcp.enabled true
```

`/mcp` 显示已配置的服务、连接状态与工具数量；连接失败的服务会被上报，而不是悄悄丢弃。

## 把 Moss 嵌入你的产品

只用 CLI？读到这里就够了。要做一个嵌入 Moss 的产品？脚手架生成一个宿主：

```bash
npx create-dmoss-app my-host
```

Moss 围绕一条狭窄的宿主边界拆分：宿主拥有模型 Key、UI、存储、遥测、设备访问、产品工具与知识包；Moss 拥有 Agent 循环、工具流水线、上下文/记忆/技能原语，以及宿主中立的安全机制。宿主注册自己的 服务商/工具/存储/审批闸门/事件接收端，发布一个 `MossHostRuntimeManifest`，并在采用新版本前于 CI 跑 `evaluateMossHostCompatibility()`。

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';
```

| 包 | 角色 |
| --- | --- |
| `@rdk-moss/core` | 公开契约、平台扩展类型、Host Adapter 契约、机器人提示词 |
| `@rdk-moss/agent` | Agent 运行时、工具循环、上下文管理、安全、技能、服务商适配 |
| `@rdk-moss/memory` · `@rdk-moss/skills` · `@rdk-moss/teaching` | 记忆选择 · 技能学习 · 边解边教标注 |
| `create-dmoss-app` | 面向外部宿主的最小项目脚手架 |

完整接口面与版本策略见 [Host Adapter 契约指南](docs/host-adapter-contract.md)。

## 给维护者与贡献者

```bash
npm install
npm run verify   # OSS 边界 + 卫生检查、构建、类型检查、lint、测试（CI 覆盖 Ubuntu/macOS/Windows）
```

长期项目手册（非会话笔记）：

- [`AGENTS.md`](AGENTS.md) —— Agent 工作规则、架构评审纪律、CodeGraph 用法、缺陷修复清单。
- [`docs/roadmap.md`](docs/roadmap.md) —— 北极星、非目标与阶段计划。
- [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md) —— Host Adapter 契约指南与版本策略。
- [`docs/tool-runtime.md`](docs/tool-runtime.md) —— 工具执行流水线、审批、超时与守卫上限。
- [`docs/release-checklist.md`](docs/release-checklist.md) —— 发布验证与宿主更新清单。
- [`ARCHITECTURE_ASSESSMENT.md`](ARCHITECTURE_ASSESSMENT.md) —— 架构结论、被否决的假设、"不要改动"的决定。

把产品专属代码（原生外壳、产品配置/密钥、板端部署、打包）留在宿主仓库——Moss 核心包要对任何机器人或设备产品宿主都通用。Moss 对其公开包面遵循 semver；patch/minor 更新应当只是一次依赖升级加验证，只有当 `MOSS_HOST_ADAPTER_CONTRACT_VERSION` 不兼容变更时才需要改适配器。
