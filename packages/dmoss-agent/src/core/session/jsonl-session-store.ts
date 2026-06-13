/**
 * JSONL Session Store — file-based session persistence using JSON Lines format.
 *
 * Each session is stored as a `.jsonl` file where each line is a JSON-encoded message.
 * This is a single-process-safe reference implementation of the SessionStore interface
 * for production use. It serializes writes within one Node process and fsyncs each
 * successful append. For multi-process writers, use SessionManager.
 *
 * Usage:
 * ```ts
 * const store = new JsonlSessionStore({ dir: '~/.moss/sessions' });
 * const agent = new DmossAgent({ llmProvider: myProvider, sessionStore: store });
 * ```
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LLMMessage } from '../llm/llm-provider.js';
import type { SessionStore, SessionMeta } from './session.js';

export interface JsonlSessionStoreConfig {
  dir: string;
  /**
   * Optional cap on the number of session files kept on disk. When set to a
   * positive integer, creating a brand-new session prunes the oldest sessions
   * (by `updatedAt`) until at most `maxSessions` remain; the session being
   * written is never a prune candidate. Omitted / `<= 0` means unbounded
   * (the default — session retention is a host policy, so moss never deletes
   * user history unless the host opts in).
   * @beta
   */
  maxSessions?: number;
}

type JsonlSessionEntry =
  | { type: 'message'; message: LLMMessage; ts?: number }
  | { type: 'state_replace'; messages: LLMMessage[]; ts?: number };

export class JsonlSessionStore implements SessionStore {
  private static readonly writeChains = new Map<string, Promise<void>>();

  private readonly dir: string;
  private readonly maxSessions: number;

  constructor(config: JsonlSessionStoreConfig) {
    this.dir = path.resolve(config.dir);
    this.maxSessions =
      typeof config.maxSessions === 'number' && Number.isFinite(config.maxSessions) && config.maxSessions > 0
        ? Math.floor(config.maxSessions)
        : 0;
  }

  private encodedSessionStem(sessionKey: string): string {
    return encodeURIComponent(sessionKey);
  }

  private decodeSessionStem(stem: string): string {
    try {
      return decodeURIComponent(stem);
    } catch {
      return stem;
    }
  }

  private sessionPath(sessionKey: string): string {
    return path.join(this.dir, `${this.encodedSessionStem(sessionKey)}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  private enqueueWrite(filePath: string, fn: () => Promise<void>): Promise<void> {
    const chains = JsonlSessionStore.writeChains;
    const prev = chains.get(filePath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(filePath, next);
    const cleanup = () => {
      if (chains.get(filePath) === next) {
        chains.delete(filePath);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async appendLineDurably(filePath: string, line: string): Promise<void> {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(filePath, 'a');
      await handle.appendFile(line, 'utf-8');
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }

  /**
   * Human-readable session title derived from the first user message, so the
   * session pickers can show "Deploy the YOLO model…" instead of a bare
   * `cli-20260613-…` key. Returns undefined when no user message exists yet
   * (never fabricates a title). Whitespace-collapsed and length-capped.
   */
  private deriveTitle(messages: LLMMessage[]): string | undefined {
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join(' ');
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned) return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
    }
    return undefined;
  }

  private replayMessagesFromContent(raw: string): { messages: LLMMessage[]; malformedCount: number } {
    const lines = raw.split('\n').filter((l) => l.trim());
    const messages: LLMMessage[] = [];
    let malformedCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlSessionEntry;
        if (entry.type === 'message' && entry.message) {
          messages.push(entry.message);
        } else if (entry.type === 'state_replace' && Array.isArray(entry.messages)) {
          messages.splice(0, messages.length, ...entry.messages);
        }
      } catch {
        malformedCount++;
      }
    }
    return { messages, malformedCount };
  }

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    const filePath = this.sessionPath(sessionKey);
    try {
      const raw = await fsp.readFile(filePath, 'utf-8');
      const { messages, malformedCount } = this.replayMessagesFromContent(raw);
      if (malformedCount > 0) {
        console.warn(`[session] ${sessionKey}: skipped ${malformedCount} malformed line(s) during load`);
      }
      return messages;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({ type: 'message', message, ts: Date.now() });
    let isNewSession = false;
    await this.enqueueWrite(filePath, async () => {
      await this.ensureDir();
      isNewSession = this.maxSessions > 0 && !(await this.fileExists(filePath));
      await this.appendLineDurably(filePath, entry + '\n');
    });
    if (isNewSession) await this.pruneOldestSessions(sessionKey);
  }

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
    const filePath = this.sessionPath(sessionKey);
    const entry = JSON.stringify({
      type: 'state_replace',
      messages,
      ts: Date.now(),
    });
    let isNewSession = false;
    await this.enqueueWrite(filePath, async () => {
      await this.ensureDir();
      isNewSession = this.maxSessions > 0 && !(await this.fileExists(filePath));
      await this.appendLineDurably(filePath, entry + '\n');
    });
    if (isNewSession) await this.pruneOldestSessions(sessionKey);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Opt-in retention: when `maxSessions` is set, delete the oldest sessions
   * (by `updatedAt`) so at most `maxSessions` remain. The session just written
   * (`keepSessionKey`) is always retained. Best-effort: a prune failure never
   * fails the originating append.
   */
  private async pruneOldestSessions(keepSessionKey: string): Promise<void> {
    if (this.maxSessions <= 0) return;
    try {
      const sessions = await this.listSessions();
      if (sessions.length <= this.maxSessions) return;
      const removable = sessions
        .filter((s) => s.sessionKey !== keepSessionKey)
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const removeCount = sessions.length - this.maxSessions;
      for (const session of removable.slice(0, removeCount)) {
        await this.deleteSession(session.sessionKey);
      }
    } catch {
      // Retention is best-effort; never let pruning surface as a write error.
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    try {
      const files = await fsp.readdir(this.dir);
      const sessions: SessionMeta[] = [];
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionKey = this.decodeSessionStem(file.replace(/\.jsonl$/, ''));
        const filePath = path.join(this.dir, file);
        try {
          const stat = await fsp.stat(filePath);
          const content = await fsp.readFile(filePath, 'utf-8');
          const activeMessages = this.replayMessagesFromContent(content).messages;
          const title = this.deriveTitle(activeMessages);
          sessions.push({
            sessionKey,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
            messageCount: activeMessages.length,
            ...(title ? { title } : {}),
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
    await this.enqueueWrite(filePath, async () => {
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    });
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
