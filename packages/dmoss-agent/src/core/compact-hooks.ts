/**
 * Compaction lifecycle hooks — pre/post hooks for context compaction events.
 */

import type { Message } from './session-jsonl.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('agent:compact-hooks');
const COMPACTION_CHECKPOINT_SECTIONS = [
  '历史脉络',
  '主要目标',
  '关键决策与约束',
  '已完成的工作',
  '当前进行中',
  '待办事项',
  '设备与环境状态',
  '关键文件与路径',
  '错误与问题',
  '后续工作所需上下文',
];

export type CompactReason = 'run_start' | 'overflow' | 'proactive' | 'manual_compact';

export function buildCompactionCheckpointOutline(summary: string | undefined): string[] | undefined {
  const clean = String(summary ?? '').trim();
  if (!clean) return undefined;
  const matched = COMPACTION_CHECKPOINT_SECTIONS.filter((section) =>
    clean.includes(section),
  );
  return matched.length > 0 ? matched : ['结构化上下文检查点'];
}

export interface PreCompactContext {
  sessionKey: string;
  runId: string;
  messages: Message[];
  reason: CompactReason;
}

export interface PostCompactContext {
  sessionKey: string;
  runId: string;
  summaryChars: number;
  droppedMessages: number;
  reason: CompactReason;
  success: boolean;
  checkpointOutline?: string[];
}

export type PreCompactHook = (ctx: PreCompactContext) => Promise<void>;
export type PostCompactHook = (ctx: PostCompactContext) => Promise<void>;

export class CompactHookRegistry {
  private preHooks: PreCompactHook[] = [];
  private postHooks: PostCompactHook[] = [];

  registerPre(hook: PreCompactHook): void {
    this.preHooks.push(hook);
  }

  registerPost(hook: PostCompactHook): void {
    this.postHooks.push(hook);
  }

  async runPreHooks(ctx: PreCompactContext): Promise<void> {
    for (const h of this.preHooks) {
      try {
        await h(ctx);
      } catch (err) {
        log.warn('pre hook failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  async runPostHooks(ctx: PostCompactContext): Promise<void> {
    for (const h of this.postHooks) {
      try {
        await h(ctx);
      } catch (err) {
        log.warn('post hook failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
