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

/** Per-session message queue to ensure sequential processing of messages. */
const sessionQueues = new Map<string, Promise<void>>();

function enqueue(sessionKey: string, fn: () => Promise<void>): void {
  const prev = sessionQueues.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 即使前一个失败也继续
  sessionQueues.set(sessionKey, next);
  // 清理已完成的队列条目
  next.then(() => {
    if (sessionQueues.get(sessionKey) === next) {
      sessionQueues.delete(sessionKey);
    }
  });
}

/**
 * Bridge a DmossAgent with a messaging channel.
 * Each incoming message is routed to agent.chat() with a per-sender session.
 * Messages for the same session are serialized to prevent concurrent agent calls.
 */
export function bridgeAgentToChannel(agent: DmossAgent, channel: MessageChannel): void {
  channel.onMessage((msg) => {
    const sessionKey = `${channel.id}-${msg.senderId}`;
    return new Promise<ChannelResponse>((resolve) => {
      enqueue(sessionKey, async () => {
        const result = await agent.chat(sessionKey, msg.text);
        resolve({
          text: result.response || '(no response)',
        });
      });
    });
  });
}
