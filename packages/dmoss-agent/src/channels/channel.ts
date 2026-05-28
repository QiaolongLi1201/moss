/**
 * Messaging Channel Abstraction — allows D-Moss to receive messages
 * from and send responses to external messaging platforms.
 *
 * Each channel adapter implements this interface to bridge a specific
 * platform (WeChat, Telegram, Discord, etc.) with DmossAgent.
 */
import type { DmossAgent } from '../core/agent/dmoss-agent.js';
import { DmossError, ErrorCode } from '../errors.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('channels');

export interface ChannelMessage {
  id: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  attachments?: Array<{
    type: 'image' | 'video' | 'file';
    url?: string;
    localPath?: string;
  }>;
}

export interface ChannelResponse {
  text: string;
  mediaFiles?: string[];
}

export interface MessageChannel {
  readonly id: string;
  readonly displayName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  onMessage(handler: (msg: ChannelMessage) => Promise<ChannelResponse>): void;
}

export interface BridgeAgentToChannelOptions {
  /**
   * Upper bound for a single channel message agent turn. Default: 120 seconds.
   *
   * When this expires the bridge aborts the agent call and releases the
   * per-sender queue. Providers and tools are expected to honor AbortSignal;
   * otherwise their late work may continue outside the channel queue.
   */
  chatTimeoutMs?: number;
  /**
   * Last-resort cap for distinct in-flight sender queues in one bridge.
   * Default: 1000. This protects hosts when upstream agent calls ignore abort
   * and many new senders arrive before old queues can be cleaned up.
   */
  maxSessionQueues?: number;
  /** Optional telemetry hook for tests or host metrics when the queue cap trips. */
  onQueueOverflow?: (event: {
    channelId: string;
    sessionKey: string;
    queueSize: number;
    maxSessionQueues: number;
  }) => void;
}

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SESSION_QUEUES = 1000;

async function chatWithTimeout(
  agent: DmossAgent,
  sessionKey: string,
  text: string,
  timeoutMs: number,
) {
  if (timeoutMs <= 0) {
    return agent.chat(sessionKey, text);
  }

  const controller = new AbortController();
  const timeoutError = new DmossError({
    code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
    message: `channel message timed out after ${timeoutMs}ms`,
    hint: 'The upstream model or a tool did not finish before the channel timeout.',
    recoverable: true,
    context: { sessionKey, timeoutMs },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const chatPromise = agent.chat(sessionKey, text, { abortSignal: controller.signal });
  chatPromise.catch(() => {
    /* suppress late rejection if timeout wins the race */
  });

  try {
    return await Promise.race([chatPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bridge a DmossAgent with a messaging channel.
 * Each incoming message is routed to agent.chat() with a per-sender session.
 * Messages for the same session are serialized to prevent concurrent agent calls.
 *
 * The per-session queue map is owned by THIS bridge invocation — multiple
 * (agent, channel) bridges in the same process get independent queues,
 * so a sessionKey collision across bridges cannot cause cross-talk.
 */
export function bridgeAgentToChannel(
  agent: DmossAgent,
  channel: MessageChannel,
  options?: BridgeAgentToChannelOptions,
): void {
  /** Per-session message queue scoped to this bridge instance. */
  const sessionQueues = new Map<string, Promise<void>>();
  const chatTimeoutMs = options?.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const maxSessionQueues = Math.max(1, Math.floor(options?.maxSessionQueues ?? DEFAULT_MAX_SESSION_QUEUES));

  const enqueue = (sessionKey: string, fn: () => Promise<void>): void => {
    if (!sessionQueues.has(sessionKey) && sessionQueues.size >= maxSessionQueues) {
      const event = {
        channelId: channel.id,
        sessionKey,
        queueSize: sessionQueues.size,
        maxSessionQueues,
      };
      log.warn('channel session queue cap reached; rejecting new sender queue', event);
      options?.onQueueOverflow?.(event);
      throw new DmossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `channel session queue cap reached (${sessionQueues.size}/${maxSessionQueues})`,
        hint: 'A previous channel agent call may be hung. Check provider/tool abort handling.',
        recoverable: true,
        context: event,
      });
    }
    const prev = sessionQueues.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(fn, fn); // 即使前一个失败也继续
    sessionQueues.set(sessionKey, next);
    // 完成后摘除尾部条目，避免 Map 无界增长
    const cleanup = () => {
      if (sessionQueues.get(sessionKey) === next) {
        sessionQueues.delete(sessionKey);
      }
    };
    next.then(cleanup, cleanup);
  };

  channel.onMessage((msg) => {
    const sessionKey = `${channel.id}-${msg.senderId}`;
    return new Promise<ChannelResponse>((resolve, reject) => {
      enqueue(sessionKey, async () => {
        try {
          const result = await chatWithTimeout(agent, sessionKey, msg.text, chatTimeoutMs);
          resolve({
            text: result.response || '(no response)',
          });
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}
