/**
 * Host-neutral async task contract for long-running Moss work.
 *
 * This deliberately models the lifecycle before any product-specific execution
 * backend is wired in. Hosts can adapt subagents, board jobs, channel
 * backplanes, or background tasks to this contract without making Moss import
 * product-specific runtime code.
 */

export type MossAsyncTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type MossAsyncTaskKind =
  | 'subagent'
  | 'host_task'
  | 'openclaw_channel';

export type MossAsyncTaskStopReason =
  | 'user_cancelled'
  | 'parent_aborted'
  | 'timeout';

export interface MossAsyncTaskStartRequest<TPayload = unknown> {
  taskId: string;
  kind: MossAsyncTaskKind;
  label?: string;
  parentTaskId?: string;
  parentRunId?: string;
  timeoutMs?: number;
  payload: TPayload;
}

export interface MossAsyncTaskResult<TData = unknown> {
  success: boolean;
  summary: string;
  data?: TData;
}

export interface MossAsyncTaskSnapshot<TPayload = unknown> {
  taskId: string;
  kind: MossAsyncTaskKind;
  label?: string;
  parentTaskId?: string;
  parentRunId?: string;
  status: MossAsyncTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs?: number;
  payload: TPayload;
  error?: string;
}

export interface MossAsyncTaskCompletion<TData = unknown> {
  taskId: string;
  status: Extract<MossAsyncTaskStatus, 'completed' | 'failed' | 'cancelled' | 'timed_out'>;
  success: boolean;
  summary: string;
  error?: string;
  data?: TData;
  startedAt?: number;
  completedAt: number;
  durationMs: number;
}

export interface MossAsyncTaskHandle {
  taskId: string;
  status: MossAsyncTaskStatus;
}

export type MossAsyncTaskRunner<TPayload = unknown, TData = unknown> = (
  request: MossAsyncTaskStartRequest<TPayload>,
  signal: AbortSignal,
) => Promise<MossAsyncTaskResult<TData>>;

export interface MossAsyncTaskRegistry {
  start<TPayload = unknown, TData = unknown>(
    request: MossAsyncTaskStartRequest<TPayload>,
    runner: MossAsyncTaskRunner<TPayload, TData>,
    options?: { parentSignal?: AbortSignal },
  ): MossAsyncTaskHandle;
  status(taskId: string): MossAsyncTaskSnapshot | undefined;
  list(filter?: { parentTaskId?: string; status?: MossAsyncTaskStatus }): MossAsyncTaskSnapshot[];
  stop(taskId: string, reason?: Exclude<MossAsyncTaskStopReason, 'timeout'>): boolean;
  wait<TData = unknown>(taskId: string): Promise<MossAsyncTaskCompletion<TData>>;
  readCompletion<TData = unknown>(taskId: string): MossAsyncTaskCompletion<TData> | undefined;
}

type InternalTaskRecord = {
  request: MossAsyncTaskStartRequest;
  snapshot: MossAsyncTaskSnapshot;
  controller: AbortController;
  parentSignal?: AbortSignal;
  onParentAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  abortReason?: MossAsyncTaskStopReason;
  runner?: MossAsyncTaskRunner;
  completion?: MossAsyncTaskCompletion;
  waiters: Array<(completion: MossAsyncTaskCompletion) => void>;
};

export interface InMemoryMossAsyncTaskRegistryOptions {
  now?: () => number;
  maxConcurrent?: number;
}

export class InMemoryMossAsyncTaskRegistry implements MossAsyncTaskRegistry {
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly records = new Map<string, InternalTaskRecord>();
  private runningCount = 0;

  constructor(options: InMemoryMossAsyncTaskRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? Number.POSITIVE_INFINITY);
  }

  start<TPayload = unknown, TData = unknown>(
    request: MossAsyncTaskStartRequest<TPayload>,
    runner: MossAsyncTaskRunner<TPayload, TData>,
    options: { parentSignal?: AbortSignal } = {},
  ): MossAsyncTaskHandle {
    if (this.records.has(request.taskId)) {
      throw new Error(`async task already exists: ${request.taskId}`);
    }

    const createdAt = this.now();
    const record: InternalTaskRecord = {
      request: request as MossAsyncTaskStartRequest,
      snapshot: {
        taskId: request.taskId,
        kind: request.kind,
        ...(request.label ? { label: request.label } : {}),
        ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
        ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
        status: 'queued',
        createdAt,
        updatedAt: createdAt,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        payload: request.payload,
      },
      controller: new AbortController(),
      parentSignal: options.parentSignal,
      runner: runner as MossAsyncTaskRunner,
      waiters: [],
    };

    this.records.set(request.taskId, record);

    if (options.parentSignal?.aborted) {
      this.stopTree(record, 'parent_aborted');
    } else {
      record.onParentAbort = () => this.stopTree(record, 'parent_aborted');
      options.parentSignal?.addEventListener('abort', record.onParentAbort, { once: true });
      this.pump();
    }

    return { taskId: request.taskId, status: record.snapshot.status };
  }

  status(taskId: string): MossAsyncTaskSnapshot | undefined {
    const record = this.records.get(taskId);
    return record ? { ...record.snapshot } : undefined;
  }

  list(filter: { parentTaskId?: string; status?: MossAsyncTaskStatus } = {}): MossAsyncTaskSnapshot[] {
    return [...this.records.values()]
      .map((record) => ({ ...record.snapshot }))
      .filter((snapshot) => {
        if (filter.parentTaskId !== undefined && snapshot.parentTaskId !== filter.parentTaskId) {
          return false;
        }
        if (filter.status !== undefined && snapshot.status !== filter.status) {
          return false;
        }
        return true;
      });
  }

  stop(taskId: string, reason: Exclude<MossAsyncTaskStopReason, 'timeout'> = 'user_cancelled'): boolean {
    const record = this.records.get(taskId);
    if (!record) return false;
    if (record.completion) return true;

    this.stopTree(record, reason);
    return true;
  }

  wait<TData = unknown>(taskId: string): Promise<MossAsyncTaskCompletion<TData>> {
    const record = this.records.get(taskId);
    if (!record) return Promise.reject(new Error(`async task not found: ${taskId}`));
    if (record.completion) return Promise.resolve(record.completion as MossAsyncTaskCompletion<TData>);
    return new Promise((resolve) => {
      record.waiters.push((completion) => resolve(completion as MossAsyncTaskCompletion<TData>));
    });
  }

  readCompletion<TData = unknown>(taskId: string): MossAsyncTaskCompletion<TData> | undefined {
    return this.records.get(taskId)?.completion as MossAsyncTaskCompletion<TData> | undefined;
  }

  private pump(): void {
    while (this.runningCount < this.maxConcurrent) {
      const next = [...this.records.values()].find((record) => record.snapshot.status === 'queued');
      if (!next) return;
      this.run(next);
    }
  }

  private run(record: InternalTaskRecord): void {
    if (record.completion || record.snapshot.status !== 'queued') return;
    const startedAt = this.now();
    record.snapshot = {
      ...record.snapshot,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
    };
    this.runningCount++;

    if (record.request.timeoutMs !== undefined) {
      record.timeout = setTimeout(() => {
        this.finishStopped(record, 'timeout');
      }, record.request.timeoutMs);
    }

    Promise.resolve()
      .then(() => {
        if (!record.runner) {
          throw new Error('async task runner is missing');
        }
        return record.runner(record.request, record.controller.signal);
      })
      .then((result) => {
        if (record.completion) return;
        if (result.success) {
          this.complete(record, {
            status: 'completed',
            success: true,
            summary: result.summary,
            data: result.data,
          });
        } else {
          this.complete(record, {
            status: 'failed',
            success: false,
            summary: result.summary,
            error: result.summary || 'task failed',
            data: result.data,
          });
        }
      })
      .catch((error) => {
        if (record.completion) return;
        const message = error instanceof Error ? error.message : String(error);
        this.complete(record, {
          status: 'failed',
          success: false,
          summary: '',
          error: message,
        });
      });
  }

  private stopTree(record: InternalTaskRecord, reason: MossAsyncTaskStopReason): void {
    this.finishStopped(record, reason);
    for (const child of this.records.values()) {
      if (child.snapshot.parentTaskId === record.request.taskId && !child.completion) {
        this.stopTree(child, 'parent_aborted');
      }
    }
  }

  private finishStopped(record: InternalTaskRecord, reason: MossAsyncTaskStopReason): void {
    if (record.completion) return;
    record.abortReason = reason;
    record.controller.abort();
    const status: MossAsyncTaskCompletion['status'] = reason === 'timeout' ? 'timed_out' : 'cancelled';
    const summary = reason === 'timeout'
      ? 'Task timed out.'
      : reason === 'parent_aborted'
        ? 'Task cancelled because its parent was aborted.'
        : 'Task cancelled.';
    this.complete(record, {
      status,
      success: false,
      summary,
      error: summary,
    });
  }

  private complete(
    record: InternalTaskRecord,
    partial: Pick<MossAsyncTaskCompletion, 'status' | 'success' | 'summary'> &
      Partial<Pick<MossAsyncTaskCompletion, 'error' | 'data'>>,
  ): void {
    if (record.completion) return;
    const completedAt = this.now();
    const startedAt = record.snapshot.startedAt;

    if (record.snapshot.status === 'running') {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }
    if (record.timeout) clearTimeout(record.timeout);
    if (record.parentSignal && record.onParentAbort) {
      record.parentSignal.removeEventListener('abort', record.onParentAbort);
    }

    const completion: MossAsyncTaskCompletion = Object.freeze({
      taskId: record.request.taskId,
      status: partial.status,
      success: partial.success,
      summary: partial.summary,
      ...(partial.error ? { error: partial.error } : {}),
      ...(partial.data !== undefined ? { data: partial.data } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      completedAt,
      durationMs: completedAt - (startedAt ?? record.snapshot.createdAt),
    });
    record.completion = completion;
    record.snapshot = {
      ...record.snapshot,
      status: partial.status,
      updatedAt: completedAt,
      completedAt,
      ...(partial.error ? { error: partial.error } : {}),
    };

    const waiters = record.waiters.splice(0);
    for (const waiter of waiters) waiter(completion);
    this.pump();
  }
}

export function createInMemoryMossAsyncTaskRegistry(
  options?: InMemoryMossAsyncTaskRegistryOptions,
): MossAsyncTaskRegistry {
  return new InMemoryMossAsyncTaskRegistry(options);
}
