/**
 * JSONL Session Store — file-based session persistence using JSON Lines format.
 *
 * Each session is stored as a `.jsonl` file where each line is a JSON-encoded message.
 * This is a reference implementation of the SessionStore interface for production use.
 *
 * Usage:
 * ```ts
 * const store = new JsonlSessionStore({ dir: '~/.dmoss/sessions' });
 * const agent = new DmossAgent({ llmProvider: myProvider, sessionStore: store });
 * ```
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { SessionStore, SessionMeta } from './session.js';

export interface JsonlSessionStoreConfig {
  dir: string;
}

type JsonlSessionEntry =
  | { type: 'message'; message: LLMMessage; ts?: number }
  | { type: 'state_replace'; messages: LLMMessage[]; ts?: number };

export class JsonlSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(config: JsonlSessionStoreConfig) {
    this.dir = config.dir;
  }

  private sessionPath(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    const filePath = this.sessionPath(sessionKey);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const messages: LLMMessage[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JsonlSessionEntry;
          if (entry.type === 'message' && entry.message) {
            messages.push(entry.message);
          } else if (entry.type === 'state_replace' && Array.isArray(entry.messages)) {
            messages.splice(0, messages.length, ...entry.messages);
          }
        } catch {
          // skip malformed lines
        }
      }
      return messages;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    await this.ensureDir();
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({ type: 'message', message, ts: Date.now() });
    await fsp.appendFile(filePath, entry + '\n', 'utf-8');
  }

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
    await this.ensureDir();
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({
      type: 'state_replace',
      messages,
      ts: Date.now(),
    });
    await fsp.appendFile(filePath, entry + '\n', 'utf-8');
  }

  async listSessions(): Promise<SessionMeta[]> {
    try {
      const files = await fsp.readdir(this.dir);
      const sessions: SessionMeta[] = [];
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionKey = file.replace(/\.jsonl$/, '');
        const filePath = path.join(this.dir, file);
        try {
          const stat = await fsp.stat(filePath);
          const content = await fsp.readFile(filePath, 'utf-8');
          const lineCount = content.split('\n').filter((l) => l.trim()).length;
          sessions.push({
            sessionKey,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
            messageCount: lineCount,
          });
        } catch {
          // skip inaccessible files
        }
      }
      return sessions;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async deleteSession(sessionKey: string): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async exists(sessionKey: string): Promise<boolean> {
    const filePath = this.sessionPath(sessionKey);
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
