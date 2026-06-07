/**
 * 文件检查点 — headless agent 风格的写前快照与撤销安全网（交互式 TUI 用）。
 * 每个用户轮次 open 一个检查点，工具写文件前备份原内容；/rewind <seq> 还原。
 * 备份落 {runtimeDir}/checkpoints/{sessionKey}/，按 seq 键（moss 消息无 uuid）。
 *
 * 安全默认 = 保住用户改动：还原前比对当前磁盘内容与「agent 写后指纹」，
 * 若用户在外部编辑器改过该文件（指纹不符），跳过还原并标记，绝不静默覆盖。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const MAX_CHECKPOINTS = 20;

/**
 * 一个被检查点跟踪的文件。
 * - backupName=null 表示备份时文件不存在（还原 = 删除）。
 * - origHash：写前原内容指纹（文件存在时），用于 agent 未实际改动时的还原判定。
 * - postHash：agent 写完后内容指纹（noteAfterWrite 记录）；为 undefined 表示未捕获到写后状态。
 * - postMissing：agent 写后该路径不存在（例如 move_file 的源被移走）。
 */
interface FileBackup {
  backupName: string | null;
  origHash: string | null;
  postHash?: string;
  postMissing?: boolean;
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

/** /rewind 结果：哪些文件被还原、哪些因外部改动被跳过（让上层提示用户）。 */
export interface RewindResult {
  /** 找到目标检查点（false = seq 不存在）。 */
  found: boolean;
  /** 实际被还原的绝对路径。 */
  restored: string[];
  /** 因检测到用户/外部改动而跳过还原的绝对路径。 */
  skipped: string[];
}

/** 计算文件内容 sha256；不存在或读失败返回 null。 */
function hashFile(absPath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
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
      if (!exists) { cp.files[absPath] = { backupName: null, origHash: null }; return; }
      const backupName = `${crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16)}@${cp.seq}`;
      fs.copyFileSync(absPath, path.join(this.dir, backupName));
      cp.files[absPath] = { backupName, origHash: hashFile(absPath) };
    } catch {
      /* best-effort：备份失败不阻塞工具执行 */
    }
  }

  /**
   * 工具写完后记录该文件的「写后指纹」（post hook 调用，运行在写入之后）。
   * 只对当前检查点内、且已在 trackBeforeWrite 登记过的路径生效；同一轮多次写入取最后一次。
   * 没有写后指纹的条目（备份成功但从未走到这里）在还原时会保守跳过。
   */
  noteAfterWrite(absPath: string): void {
    const cp = this.checkpoints[this.checkpoints.length - 1];
    const entry = cp?.files[absPath];
    if (!entry) return;
    const h = hashFile(absPath);
    if (h === null) {
      entry.postMissing = true;
      entry.postHash = undefined;
    } else {
      entry.postMissing = false;
      entry.postHash = h;
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

  /**
   * 还原到目标检查点之前的状态：从最新回滚到目标，恢复各文件写前备份；丢弃目标及之后记录。
   *
   * 安全默认：每个文件还原前先确认它仍是 agent 当初留下的样子——
   * 当前磁盘内容须等于「写后指纹」(postHash)；agent 实际没改的文件则须仍等于写前原内容。
   * 任一不符（用户在外部改/删过）→ 跳过该文件并计入 skipped，绝不覆盖用户改动。
   */
  rewindTo(seq: number): RewindResult {
    const idx = this.checkpoints.findIndex((c) => c.seq === seq);
    if (idx < 0) return { found: false, restored: [], skipped: [] };
    const restored: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      for (const [absPath, backup] of Object.entries(this.checkpoints[i].files)) {
        if (seen.has(absPath)) continue;
        seen.add(absPath);
        if (!this.isSafeToRestore(absPath, backup)) {
          skipped.push(absPath);
          continue;
        }
        try {
          if (backup.backupName === null) fs.rmSync(absPath, { force: true });
          else fs.copyFileSync(path.join(this.dir, backup.backupName), absPath);
          restored.push(absPath);
        } catch {
          /* skip 单个文件失败 */
          skipped.push(absPath);
        }
      }
    }
    this.checkpoints = this.checkpoints.slice(0, idx);
    return { found: true, restored, skipped };
  }

  /**
   * 当前磁盘上的文件是否仍是 agent 留下的样子（可安全还原而不丢用户改动）。
   * - 有写后指纹(postHash)：当前内容须与之一致。
   * - agent 写后该路径不存在(postMissing)：当前也须不存在。
   * - 没有写后指纹（未捕获到写后状态）：退回写前原内容判定——当前须仍等于原内容；
   *   原本就不存在(origHash=null)的，要求当前仍不存在。任何分叉一律保守跳过。
   */
  private isSafeToRestore(absPath: string, backup: FileBackup): boolean {
    const liveHash = hashFile(absPath);
    if (backup.postMissing) return liveHash === null;
    if (backup.postHash !== undefined) return liveHash === backup.postHash;
    if (backup.origHash === null) return liveHash === null;
    return liveHash === backup.origHash;
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
