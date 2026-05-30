/**
 * Skill validation & template generation utilities.
 *
 * Used by DMossApp.writeLocalSkill to validate SKILL.md content before
 * persisting, and by the Skill Manager to generate high-quality scaffolds.
 */

/* ------------------------------------------------------------------ */
/*  Frontmatter validation                                             */
/* ------------------------------------------------------------------ */

const REQUIRED_FIELDS = [
  'name',
  'description',
  'version',
  'trigger',
  'risk',
  'permissions',
  'delegate_preference',
  'requires_board',
  'approval_level',
  'cooldown_seconds',
  'scheduler_template',
  'category',
] as const;

const RISK_VALUES = ['low', 'medium', 'high'] as const;
const DELEGATE_VALUES = ['local', 'board', 'hybrid', 'collaborative'] as const;
const APPROVAL_VALUES = ['none', 'confirm', 'strict'] as const;
/** Legacy alias accepted with a warning so old user-authored / external skills keep loading. */
const APPROVAL_LEGACY_ALIASES = ['auto'] as const;

const CAMEL_TO_KEBAB: Record<string, string> = {
  disableModelInvocation: 'disable-model-invocation',
  userInvocable: 'user-invocable',
  delegatePreference: 'delegate_preference',
  requiresBoard: 'requires_board',
  approvalLevel: 'approval_level',
  cooldownSeconds: 'cooldown_seconds',
  schedulerTemplate: 'scheduler_template',
};

export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Extract frontmatter from a SKILL.md string.
 * Returns key-value pairs from the YAML block between `---` markers.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return result;
}

/**
 * SkillHub 等外部来源常见仅含 name/description 等少量字段；写入本机 workspace 前补齐 RDK 必填 frontmatter，
 * 再通过 {@link validateSkillContent} 校验。
 */
export function mergeSkillFrontmatterDefaults(content: string, opts: { skillId: string }): string {
  const skillId = String(opts.skillId || '').trim() || 'skill';
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = match ? content.slice(match[0].length).replace(/^\r?\n/, '') : content.trim();
  const fm = match ? parseFrontmatter(content) : {};

  const defaults: Record<(typeof REQUIRED_FIELDS)[number], string> = {
    name: skillId,
    description: `Imported workspace skill "${skillId}" for local Moss. Describe what it does and when to use it (WHAT + WHEN).`,
    version: '1.0.0',
    trigger: `${skillId}, assistant`,
    risk: 'low',
    permissions: 'workspace_read',
    delegate_preference: 'local',
    requires_board: 'false',
    approval_level: 'none',
    cooldown_seconds: '0',
    scheduler_template: 'none',
    category: 'imported',
  };

  const merged: Record<string, string> = {};
  for (const field of REQUIRED_FIELDS) {
    const v = fm[field]?.trim();
    merged[field] = v || defaults[field];
  }

  let desc = merged.description;
  if (desc.length < 20) {
    desc = `${desc} — 请补充具体能力说明与触发场景。`.trim();
  }
  if (desc.length < 20) {
    merged.description = defaults.description;
  } else {
    merged.description = desc;
  }

  const reqSet = new Set<string>([...REQUIRED_FIELDS]);
  const extraKeys = Object.keys(fm).filter((k) => !reqSet.has(k));

  const lines: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    lines.push(`${field}: ${merged[field]}`);
  }
  for (const k of extraKeys) {
    const v = fm[k]?.trim();
    if (v) lines.push(`${k}: ${v}`);
  }

  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

/**
 * Validate SKILL.md content.
 * Returns errors (blocking) and warnings (advisory).
 */
export function validateSkillContent(content: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content.trim()) {
    return { valid: false, errors: ['SKILL.md 内容不能为空'], warnings: [] };
  }

  const fm = parseFrontmatter(content);

  if (Object.keys(fm).length === 0) {
    errors.push('缺少 YAML frontmatter（文件应以 --- 开头）');
    return { valid: false, errors, warnings };
  }

  // Check for camelCase keys that should be kebab-case or snake_case
  for (const [camel, kebab] of Object.entries(CAMEL_TO_KEBAB)) {
    if (fm[camel] !== undefined && fm[kebab] === undefined) {
      warnings.push(`字段 "${camel}" 应使用 "${kebab}"，加载器不识别 camelCase 形式`);
    }
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) {
      errors.push(`缺少必填字段: ${field}`);
    }
  }

  // Description quality
  if (fm.description) {
    const desc = fm.description;
    if (desc.length < 20) {
      errors.push(`description 太短（${desc.length} 字符），至少需要 20 字符，包含 WHAT + WHEN`);
    }
    if (/^帮助|^辅助|^处理/.test(desc)) {
      warnings.push('description 以空泛动词开头，建议改为第三人称具体能力描述（WHAT + WHEN）');
    }
  }

  // Enum value validation
  if (fm.risk && !RISK_VALUES.includes(fm.risk as typeof RISK_VALUES[number])) {
    errors.push(`risk 值无效: "${fm.risk}"，应为 ${RISK_VALUES.join(' | ')}`);
  }
  if (fm.delegate_preference && !DELEGATE_VALUES.includes(fm.delegate_preference as typeof DELEGATE_VALUES[number])) {
    errors.push(`delegate_preference 值无效: "${fm.delegate_preference}"，应为 ${DELEGATE_VALUES.join(' | ')}`);
  }
  if (fm.approval_level && !APPROVAL_VALUES.includes(fm.approval_level as typeof APPROVAL_VALUES[number])) {
    if ((APPROVAL_LEGACY_ALIASES as readonly string[]).includes(fm.approval_level)) {
      warnings.push(`approval_level "${fm.approval_level}" 为遗留别名，建议改为 "confirm"`);
    } else {
      errors.push(`approval_level 值无效: "${fm.approval_level}"，应为 ${APPROVAL_VALUES.join(' | ')}`);
    }
  }

  // Trigger presence
  if (fm.trigger) {
    const triggers = fm.trigger.split(',').map(t => t.trim()).filter(Boolean);
    if (triggers.length < 2) {
      warnings.push('trigger 关键词少于 2 个，建议覆盖中英文常见说法');
    }
  }

  // Body quality checks
  const body = content.replace(/^---[\s\S]*?---/, '').trim();
  if (body.length < 50) {
    warnings.push('正文内容过短，建议包含执行流程、工具映射和示例');
  }
  if (!/##.*(?:执行流程|流程|Steps|Workflow)/i.test(body)) {
    warnings.push('正文缺少 "执行流程" 章节');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/*  Template generation                                                */
/* ------------------------------------------------------------------ */

export interface SkillTemplateParams {
  name: string;
  description: string;
  category: string;
  requiresBoard: boolean;
  triggers: string[];
  risk?: 'low' | 'medium' | 'high';
  permissions?: string[];
  delegatePreference?: 'local' | 'board' | 'hybrid' | 'collaborative';
}

/**
 * Generate a high-quality SKILL.md scaffold with all required frontmatter
 * and a structured body following the rdk-skill-authoring-guide template.
 */
export function generateSkillTemplate(params: SkillTemplateParams): string {
  const risk = params.risk ?? 'low';
  const permissions = params.permissions
    ?? (params.requiresBoard ? ['workspace_read', 'device_exec'] : ['workspace_read']);
  const delegate = params.delegatePreference ?? 'local';
  const triggers = params.triggers.length > 0
    ? params.triggers.join(',')
    : params.name;

  return `---
name: ${params.name}
description: ${params.description}
version: 1.0.0
trigger: ${triggers}
risk: ${risk}
permissions: ${permissions.join(',')}
delegate_preference: ${delegate}
requires_board: ${params.requiresBoard}
approval_level: none
cooldown_seconds: 0
scheduler_template: none
category: ${params.category}
---

# ${params.name}

## 适用场景
- 当用户需要 <!-- 具体场景 --> 时触发

## 前置条件
${params.requiresBoard ? '- 已连接 RDK 设备（device_connect_ssh）\n- 设备可通过 SSH 访问' : '- 无特殊前置条件'}

## 执行流程
1. <!-- 具体步骤，对应工具名称 -->
2. <!-- 具体步骤，对应工具名称 -->
3. <!-- 验证步骤 -->

## 工具映射
| 工具 | 用途 | 必需 |
|------|------|------|
| <!-- tool_name --> | <!-- 作用 --> | 是 |

## 输出要求
- <!-- Agent 必须输出的内容 -->

## 示例
**情境**：用户说「<!-- 用户的原始请求 -->」
**期望**：
1. Agent 执行 <!-- 步骤摘要 -->
2. 输出 <!-- 预期结果 -->

## 失败与降级
- 无设备连接时：<!-- 降级策略 -->
- 命令执行失败时：<!-- 重试或替代方案 -->

## 禁止事项
- 不可 <!-- 具体约束 -->
`;
}
