/**
 * Agent Session — abstract interface for conversation state management.
 *
 * Host applications implement SessionStore to provide persistence.
 * D-Moss agent uses AgentSession to manage conversation flow.
 */

import type { LLMMessage } from './llm-provider.js';

export interface SessionMeta {
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messageCount: number;
}

/**
 * Abstract session store — host implements this for persistence
 * (file system, database, in-memory, etc.).
 */
export interface SessionStore {
  /** Load messages for a session */
  loadMessages(sessionKey: string): Promise<LLMMessage[]>;

  /** Append a message to the session */
  appendMessage(sessionKey: string, message: LLMMessage): Promise<void>;

  /** Replace all messages (e.g. after compaction) */
  replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void>;

  /** List all sessions */
  listSessions(): Promise<SessionMeta[]>;

  /** Delete a session */
  deleteSession(sessionKey: string): Promise<void>;

  /** Check if a session exists */
  exists(sessionKey: string): Promise<boolean>;
}

/**
 * In-memory session store — useful for testing and lightweight use cases.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, { messages: LLMMessage[]; meta: SessionMeta }>();

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    return [...(this.sessions.get(sessionKey)?.messages ?? [])];
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        messages: [],
        meta: { sessionKey, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      };
      this.sessions.set(sessionKey, session);
    }
    session.messages.push(message);
    session.meta.updatedAt = Date.now();
    session.meta.messageCount = session.messages.length;
  }

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        messages: [],
        meta: { sessionKey, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      };
      this.sessions.set(sessionKey, session);
    }
    session.messages = [...messages];
    session.meta.updatedAt = Date.now();
    session.meta.messageCount = messages.length;
  }

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  async deleteSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }

  async exists(sessionKey: string): Promise<boolean> {
    return this.sessions.has(sessionKey);
  }
}
