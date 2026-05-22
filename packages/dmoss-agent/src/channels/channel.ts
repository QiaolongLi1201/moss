/**
 * Messaging Channel Abstraction — allows D-Moss to receive messages
 * from and send responses to external messaging platforms.
 *
 * Each channel adapter implements this interface to bridge a specific
 * platform (WeChat, Telegram, Discord, etc.) with DmossAgent.
 */

import type { DmossAgent } from '../core/dmoss-agent.js';

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
 */
export function bridgeAgentToChannel(
  agent: DmossAgent,
  channel: MessageChannel,
): void {
  channel.onMessage(async (msg) => {
    const sessionKey = `${channel.id}-${msg.senderId}`;
    const result = await agent.chat(sessionKey, msg.text);
    return {
      text: result.response || '(no response)',
    };
  });
}
