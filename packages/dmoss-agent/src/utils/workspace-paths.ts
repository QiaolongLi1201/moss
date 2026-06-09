import fs from 'node:fs';
import path from 'node:path';

export interface MossWorkspacePaths {
  workspaceDir: string;
  runtimeDir: string;
  sessionsDir: string;
  memoryDir: string;
  checkpointsDir: string;
  attachmentsDir: string;
  projectConfigPath: string;
  skillsDir: string;
  learnedSkillsDir: string;
  skillCandidatesDir: string;
  agentSkillsDir: string;
  legacyRuntimeDir: string;
  legacySessionsDir: string;
  legacyMemoryDir: string;
  legacyCheckpointsDir: string;
  legacyAttachmentsDir: string;
  legacyProjectConfigDir: string;
  legacyProjectConfigPath: string;
  legacySkillsDir: string;
  legacyLearnedSkillsDir: string;
  legacySkillCandidatesDir: string;
  legacyAgentSkillsDir: string;
}

export interface WorkspacePathMigrationResult {
  paths: MossWorkspacePaths;
  migratedPaths: string[];
  skippedPaths: string[];
}

export function getMossWorkspacePaths(workspaceDir: string): MossWorkspacePaths {
  const root = path.resolve(workspaceDir);
  const runtimeDir = path.join(root, '.moss');
  const skillsDir = path.join(runtimeDir, 'skills');
  const legacyRuntimeDir = path.join(root, '.dmoss-runtime');
  const legacySkillsDir = path.join(root, 'skills');
  return {
    workspaceDir: root,
    runtimeDir,
    sessionsDir: path.join(runtimeDir, 'sessions'),
    memoryDir: path.join(runtimeDir, 'memory'),
    checkpointsDir: path.join(runtimeDir, 'checkpoints'),
    attachmentsDir: path.join(runtimeDir, 'attachments'),
    projectConfigPath: path.join(runtimeDir, 'config.json'),
    skillsDir,
    learnedSkillsDir: path.join(skillsDir, 'learned'),
    skillCandidatesDir: path.join(skillsDir, 'candidates'),
    agentSkillsDir: path.join(runtimeDir, 'agent', 'skills'),
    legacyRuntimeDir,
    legacySessionsDir: path.join(legacyRuntimeDir, 'sessions'),
    legacyMemoryDir: path.join(legacyRuntimeDir, 'memory'),
    legacyCheckpointsDir: path.join(legacyRuntimeDir, 'checkpoints'),
    legacyAttachmentsDir: path.join(legacyRuntimeDir, 'attachments'),
    legacyProjectConfigDir: path.join(root, '.dmoss'),
    legacyProjectConfigPath: path.join(root, '.dmoss', 'config.json'),
    legacySkillsDir,
    legacyLearnedSkillsDir: path.join(legacySkillsDir, 'learned'),
    legacySkillCandidatesDir: path.join(root, 'skill-candidates'),
    legacyAgentSkillsDir: path.join(root, 'agent', 'skills'),
  };
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function removeIfEmpty(dir: string): void {
  if (!pathExists(dir)) return;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Best-effort cleanup only. A failed rmdir must not block migration.
  }
}

function migratePath(src: string, dest: string, result: WorkspacePathMigrationResult): void {
  if (!pathExists(src)) return;
  const srcStat = fs.lstatSync(src);
  if (!pathExists(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    result.migratedPaths.push(`${src} -> ${dest}`);
    return;
  }

  const destStat = fs.lstatSync(dest);
  if (srcStat.isDirectory() && destStat.isDirectory()) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      migratePath(path.join(src, entry.name), path.join(dest, entry.name), result);
    }
    removeIfEmpty(src);
    return;
  }

  result.skippedPaths.push(`${src} -> ${dest}`);
}

function migrateLegacySkillDirs(paths: MossWorkspacePaths, result: WorkspacePathMigrationResult): void {
  if (!pathExists(paths.legacySkillsDir)) return;
  for (const entry of fs.readdirSync(paths.legacySkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'learned') continue;
    const legacySkillDir = path.join(paths.legacySkillsDir, entry.name);
    if (!pathExists(path.join(legacySkillDir, 'SKILL.md'))) continue;
    migratePath(legacySkillDir, path.join(paths.skillsDir, entry.name), result);
  }
}

export function migrateLegacyWorkspacePaths(workspaceDir: string): WorkspacePathMigrationResult {
  const paths = getMossWorkspacePaths(workspaceDir);
  const result: WorkspacePathMigrationResult = {
    paths,
    migratedPaths: [],
    skippedPaths: [],
  };

  migratePath(paths.legacySessionsDir, paths.sessionsDir, result);
  migratePath(paths.legacyMemoryDir, paths.memoryDir, result);
  migratePath(paths.legacyCheckpointsDir, paths.checkpointsDir, result);
  migratePath(paths.legacyAttachmentsDir, paths.attachmentsDir, result);
  migratePath(paths.legacyProjectConfigPath, paths.projectConfigPath, result);
  migratePath(paths.legacyLearnedSkillsDir, paths.learnedSkillsDir, result);
  migrateLegacySkillDirs(paths, result);
  migratePath(paths.legacySkillCandidatesDir, paths.skillCandidatesDir, result);
  migratePath(paths.legacyAgentSkillsDir, paths.agentSkillsDir, result);

  removeIfEmpty(paths.legacyRuntimeDir);
  removeIfEmpty(paths.legacyProjectConfigDir);
  removeIfEmpty(paths.legacySkillsDir);
  removeIfEmpty(path.join(paths.workspaceDir, 'agent'));

  return result;
}
