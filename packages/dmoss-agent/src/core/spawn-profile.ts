/**
 * sessions_spawn 子代理：工具范围 + 系统提示附加段
 *
 * 三种常见 sub-agent 配置 — Explore / Plan / Verification（业界常见的 agent 编排分工）：
 * - explore：只读探索（工作区 + 可选设备端只读 + 联网检索 + 附件）
 * - plan： explore + create_plan / update_plan，输出须含「关键文件」清单
 * - verify： 允许 exec / device_exec 做构建与检查，禁止改仓库/设备端写文件/委派
 */

/** 与 sessions_spawn.toolScope 一致 */
export type SpawnToolScope =
  | "read-only"
  | "device-read"
  | "full"
  | "explore"
  | "plan"
  | "verify";

const CORE_READ_TOOLS = [
  "read", "list", "grep", "memory_search", "memory_get",
];

const DEVICE_READ_TOOLS = [
  "device_file_read", "device_file_list", "device_diagnose",
];

const WEB_TOOLS = [
  "web_search", "web_fetch", "web_extract", "web_browser_fetch",
];

const ATTACHMENT_TOOLS = [
  "attachment_list", "attachment_read", "attachment_describe_image",
  "attachment_get_audio_transcript",
];

const SKILL_TOOLS = ["find_skills", "skillhub_search"];

let _hostSpawnToolExtensions: Record<string, string[]> = {};

/**
 * Register additional tool names for spawn scopes.
 * Called by the host application to inject product-specific tools
 * (e.g., board agent status tools, device-specific commands).
 */
export function registerSpawnToolExtensions(
  extensions: Record<string, string[]>,
): void {
  _hostSpawnToolExtensions = { ...extensions };
}

function hostToolsForScope(scope: string): string[] {
  return _hostSpawnToolExtensions[scope] ?? _hostSpawnToolExtensions['*'] ?? [];
}

/** 各范围允许的工具名；full 不使用此表（由上层不传 filter 表示全量） */
export const SPAWN_TOOL_SCOPE_SETS: Record<
  Exclude<SpawnToolScope, "full">,
  Set<string>
> = {
  "read-only": new Set(CORE_READ_TOOLS),
  "device-read": new Set([
    ...CORE_READ_TOOLS,
    ...DEVICE_READ_TOOLS,
    ...hostToolsForScope("device-read"),
  ]),
  explore: new Set([
    ...CORE_READ_TOOLS,
    ...ATTACHMENT_TOOLS,
    ...WEB_TOOLS,
    ...SKILL_TOOLS,
    ...DEVICE_READ_TOOLS,
    ...hostToolsForScope("explore"),
  ]),
  plan: new Set([
    ...CORE_READ_TOOLS,
    ...ATTACHMENT_TOOLS,
    ...WEB_TOOLS,
    ...SKILL_TOOLS,
    "create_plan", "update_plan",
    ...DEVICE_READ_TOOLS,
    ...hostToolsForScope("plan"),
  ]),
  verify: new Set([
    ...CORE_READ_TOOLS,
    ...ATTACHMENT_TOOLS,
    ...WEB_TOOLS,
    ...SKILL_TOOLS,
    "exec", "device_exec",
    ...DEVICE_READ_TOOLS,
    ...hostToolsForScope("verify"),
  ]),
};

export function resolveSpawnToolSet(
  scope: SpawnToolScope | undefined,
): Set<string> | null {
  if (!scope || scope === "full") return null;
  return SPAWN_TOOL_SCOPE_SETS[scope];
}

/**
 * 追加在子代理 system prompt 末尾；与主会话其它段落冲突时以本节为准。
 */
export function buildSubagentPromptAddon(scope: SpawnToolScope): string {
  if (scope === "full" || scope === "read-only" || scope === "device-read") {
    return "";
  }
  if (scope === "explore") {
    return [
      "## 子代理模式：Explore（只读探索）",
      "本节覆盖与「修改/写入/执行破坏性命令」相关的任何宽泛描述。",
      "",
      "你是代码与环境的**只读**探索者：",
      "- 禁止：`write` `edit` `exec` `device_exec` `memory_save`、任何形式的设备端**委派/写技能/写文件**/刷机类工具（本会话已裁剪工具列表）。",
      "- 使用 `read` `list` `grep` 理解工作区；已连接设备时用 `device_file_*` `device_diagnose` 等**只读**手段核对设备端状态。",
      "- 需要官方说明时用 `web_search` / `web_fetch`；无依赖的检索与多文件读取尽量**并行**。",
      "- **不要**在探索阶段写实施总结以外的「待办迁移」；最终回复：简明发现与引用路径/命令要点。",
    ].join("\n");
  }
  if (scope === "plan") {
    return [
      "## 子代理模式：Plan（只读规划）",
      "本节覆盖与「直接改代码」相关的任何宽泛描述。",
      "",
      "你只负责**阅读与规划**，不得修改仓库或设备端：",
      "- 禁止：`write` `edit` `exec` `device_exec` `memory_save` 及任何写入/委派类工具（已裁剪）。",
      "- 用 `read` `list` `grep` 与（若可用）`create_plan` / `update_plan` 维护计划条目。",
      "- 输出须包含：**分步实施方案**、依赖与顺序、主要风险。",
      "",
      "### 必备小节：关键文件（实现入口）",
      "文末**必须**包含如下 Markdown 小节，列出 3–7 个对实现最关键的路径（可含设备端路径说明）：",
      "### 关键文件（实现入口）",
      "- path/to/file1",
      "- path/to/file2",
    ].join("\n");
  }
  if (scope === "verify") {
    return [
      "## 子代理模式：Verify（验收 / 试图证伪）",
      "你的职责**不是**附和实现者，而是**尽量证伪**：能跑命令、抓输出的地方必须跑，禁止仅读过代码就写「通过」。",
      "",
      "### 硬约束",
      "- 禁止修改用户工作区与设备端持久化内容：不得使用 `write` `edit` `device_file_write`、设备端**委派**、刷机/安装/卸载/渠道配置等变更类工具（已裁剪）。",
      "- 允许：宿主 `exec`、设备端 `device_exec` 用于构建、测试、curl、诊断；只读类工具与 `web_*` 用于对照文档。",
      "- 可 `read` / `grep` 查 README、AGENTS.md、package.json、Makefile 等以确认约定命令。",
      "",
      "### 防推卸（自我检查）",
      "- 「代码看起来对」≠ 已验证；缺命令输出则**不得**标为通过。",
      "- 「上游测试已过」≠ 你已完成独立验收；至少做一类与变更类型匹配的**对抗性检查**（边界入参、空输入、简单并发/重复请求等，择一贴合场景）。",
      "",
      "### 每条检查必须具备（否则视为未执行）",
      "对每个检查项，使用如下结构（缺一不可）：",
      "```",
      "### 检查：<简短描述>",
      "**执行的命令：**",
      "  <逐字可复制的命令>",
      "**观测到的输出：**",
      "  <终端或工具返回摘录，勿用散文代替>",
      "**结果：** PASS 或 FAIL（FAIL 须写清期望 vs 实际）",
      "```",
      "",
      "### 裁决行（须原样一字不差，单独成行，便于解析）",
      "全文最后一行必须是下列之一（勿加粗、勿改标点）：",
      "VERDICT: PASS",
      "VERDICT: FAIL",
      "VERDICT: PARTIAL",
      "",
      "**PARTIAL** 仅用于环境缺失（如无测试框架、设备不可达且与实现无关），不可用「不确定是否有 bug」搪塞。",
    ].join("\n");
  }
  return "";
}
