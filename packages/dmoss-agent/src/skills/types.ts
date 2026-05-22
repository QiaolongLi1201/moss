/**
 * Skill metadata types — generic skill system for D-Moss Agent.
 */

export interface SkillPermission {
  workspaceRead?: boolean;
  workspaceWrite?: boolean;
  deviceExec?: boolean;
  network?: boolean;
}

export interface SkillRuntimePolicy {
  delegatePreference?: 'local' | 'board' | 'hybrid' | 'collaborative';
  requiresBoard?: boolean;
  approvalLevel?: 'none' | 'confirm' | 'strict';
  cooldownSeconds?: number;
  schedulerTemplate?: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  sourcePath: string;
  version: string;
  tags: string[];
  trigger: string[];
  risk: 'low' | 'medium' | 'high';
  permissions: SkillPermission;
  runtimePolicy?: SkillRuntimePolicy;
  enabled: boolean;
  updatedAt: number;
}
