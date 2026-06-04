/**
 * 文件检查点 — Claude Code 风格的写前快照与撤销安全网（交互式 TUI 用）。
 * 每个用户轮次 open 一个检查点，工具写文件前备份原内容；/rewind <seq> 还原。
 * 备份落 {runtimeDir}/checkpoints/{sessionKey}/，按 seq 键（moss 消息无 uuid）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const MAX_CHECKPOINTS = 20;

/** backupName=null 表示备份时文件不存在（还原时应删除）。 */
interface FileBackup {
  backupName: string | null;
}

interface Checkpoint {
  seq: number;
  label: string;
  ts: number;
  files: Record<string, FileBackup>;
}

export interface CheckpointSummary {
  seq: number;
  label: string;
  ts: number;
  fileCount: number;
}

export class FileCheckpointStore {
  private readonly dir: string;
  private checkpoints: Checkpoint[] = [];
  private seq = 0;

  constructor(opts: { runtimeDir: string; sessionKey: string }) {
    this.dir = path.join(opts.runtimeDir, 'checkpoints', encodeURIComponent(opts.sessionKey));
  }

  /** 开新检查点（每个用户轮次一个）；丢弃上一个未发生写入的空检查点，滚动淘汰超上限。 */
  open(label: string): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && Object.keys(last.files).length === 0) this.checkpoints.pop();
    this.checkpoints.push({ seq: ++this.seq, label: label.slice(0, 60), ts: Date.now(), files: {} });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS);
    }
  }

  /** 写文件前备份原内容；同一检查点内同一文件只备份一次（保留最初状态）。 */
  trackBeforeWrite(absPath: string): void {
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (!cp || cp.files[absPath] !== undefined) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let exists = true;
      try { fs.accessSync(absPath); } catch { exists = false; }
      if (!exists) { cp.files[absPath] = { backupName: null }; return; }
      const backupName = `${crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16)}@${cp.seq}`;
      fs.copyFileSync(absPath, path.join(this.dir, backupName));
      cp.files[absPath] = { backupName };
    } catch {
      /* best-effort：备份失败不阻塞工具执行 */
    }
  }

  hasCheckpoints(): boolean {
    return this.checkpoints.some((c) => Object.keys(c.files).length > 0);
  }

  list(): CheckpointSummary[] {
    return this.checkpoints
      .filter((c) => Object.keys(c.files).length > 0)
      .map((c) => ({ seq: c.seq, label: c.label, ts: c.ts, fileCount: Object.keys(c.files).length }));
  }

  /** 还原到目标检查点之前的状态：从最新回滚到目标，恢复各文件写前备份；丢弃目标及之后记录。 */
  rewindTo(seq: number): string[] {
    const idx = this.checkpoints.findIndex((c) => c.seq === seq);
    if (idx < 0) return [];
    const restored: string[] = [];
    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      for (const [absPath, backup] of Object.entries(this.checkpoints[i].files)) {
        try {
          if (backup.backupName === null) fs.rmSync(absPath, { force: true });
          else fs.copyFileSync(path.join(this.dir, backup.backupName), absPath);
          if (!restored.includes(absPath)) restored.push(absPath);
        } catch {
          /* skip 单个文件失败 */
        }
      }
    }
    this.checkpoints = this.checkpoints.slice(0, idx);
    return restored;
  }
}

/** 从工具输入提取将被写入的绝对路径（write_file/move_file/apply_patch）。 */
export function checkpointTargetPaths(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string,
  parsePatchPaths: (patch: string) => string[],
): string[] {
  const resolve = (p: unknown): string | null =>
    typeof p === 'string' && p.trim() ? path.resolve(workspaceDir, p) : null;
  if (toolName === 'write_file') {
    const p = resolve(input.path ?? input.file_path);
    return p ? [p] : [];
  }
  if (toolName === 'move_file') {
    const out: string[] = [];
    const from = resolve(input.source ?? input.from);
    const to = resolve(input.destination ?? input.to);
    if (from) out.push(from);
    if (to) out.push(to);
    return out;
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    return parsePatchPaths(input.patch).map((rel) => path.resolve(workspaceDir, rel));
  }
  return [];
}
