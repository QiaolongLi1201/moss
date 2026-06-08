import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from './pi-ai-types.js';

export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  private readonly queue: TEvent[] = [];
  private readonly waiting: Array<(result: IteratorResult<TEvent>) => void> = [];
  private done = false;
  private readonly finalResultPromise: Promise<TResult>;
  private resolveFinalResult!: (result: TResult) => void;

  constructor(
    private readonly isComplete: (event: TEvent) => boolean,
    private readonly extractResult: (event: TEvent) => TResult,
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: TEvent): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  end(result?: TResult): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }

    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    while (true) {
      if (this.queue.length > 0) {
        const queued = this.queue.shift() as TEvent;
        yield queued;
        continue;
      }
      if (this.done) return;

      const result = await new Promise<IteratorResult<TEvent>>((resolve) => {
        this.waiting.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  result(): Promise<TResult> {
    return this.finalResultPromise;
  }
}

class LocalAssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message;
        if (event.type === 'error') return event.error;
        throw new Error('Unexpected event type for final result');
      },
    );
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
}
