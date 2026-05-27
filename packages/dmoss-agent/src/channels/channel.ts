/**
 * Messaging Channel Abstraction — allows D-Moss to receive messages
 * from and send responses to external messaging platforms.
 *
 * Each channel adapter implements this interface to bridge a specific
 * platform (WeChat, Telegram, Discord, etc.) with DmossAgent.
 */
import type { DmossAgent } from '../core/agent/dmoss-agent.js';

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

/**
 * Bridge a DmossAgent with a messaging channel.
 * Each incoming message is routed to agent.chat() with a per-sender session.
 * Messages for the same session are serialized to prevent concurrent agent calls.
 *
 * The per-session queue map is owned by THIS bridge invocation — multiple
 * (agent, channel) bridges in the same process get independent queues,
 * so a sessionKey collision across bridges cannot cause cross-talk.
 */
export function bridgeAgentToChannel(agent: DmossAgent, channel: MessageChannel): void {
  /** Per-session message queue scoped to this bridge instance. */
  const sessionQueues = new Map<string, Promise<void>>();

  const enqueue = (sessionKey: string, fn: () => Promise<void>): void => {
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
          const result = await agent.chat(sessionKey, msg.text);
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
