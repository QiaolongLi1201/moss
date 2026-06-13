import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type { SessionMeta, SessionStore } from '../core/session/session.js';

export interface CliSessionResolution {
  sessionKey: string;
  sourceSessionKey?: string;
  forked: boolean;
  notice?: string;
  /**
   * Set when an explicit session key was requested but does not exist. The CLI
   * must surface this and exit non-zero instead of printing a false
   * "Resuming session" notice over an empty conversation.
   */
  error?: string;
}

function sortRecent(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function timestampForKey(now = new Date()): string {
  return now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

export function createCliSessionKey(): string {
  return `cli-${timestampForKey()}-${randomUUID().slice(0, 8)}`;
}

function describeSession(meta: SessionMeta): string {
  const updated = Number.isFinite(meta.updatedAt)
    ? new Date(meta.updatedAt).toLocaleString()
    : 'unknown time';
  return `${meta.sessionKey} (${meta.messageCount} messages, updated ${updated})`;
}

async function promptForSession(sessions: SessionMeta[]): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const recent = sortRecent(sessions).slice(0, 10);
  process.stderr.write('[sessions]\n');
  recent.forEach((session, idx) => {
    process.stderr.write(`  ${idx + 1}. ${describeSession(session)}\n`);
  });
  process.stderr.write('Select a session number, or press Enter for the latest: ');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(recent[0]?.sessionKey ?? null);
        return;
      }
      const selected = Number.parseInt(trimmed, 10);
      if (Number.isFinite(selected) && selected >= 1 && selected <= recent.length) {
        resolve(recent[selected - 1].sessionKey);
        return;
      }
      resolve(trimmed);
    });
  });
}

async function resolveExistingSession(
  store: SessionStore,
  explicit: string | undefined,
  useLast: boolean,
): Promise<{ key: string; notice?: string; error?: string } | null> {
  if (explicit) {
    // Verify the key actually exists before claiming a resume. Returning it
    // unchecked printed "Resuming session: <key>" then ran an empty session
    // when the key was a typo (no success without a verified outcome).
    if (await store.exists(explicit)) return { key: explicit };
    return { key: explicit, error: `No saved session named "${explicit}" in this workspace.` };
  }
  const sessions = sortRecent(await store.listSessions());
  if (sessions.length === 0) return null;
  if (useLast) return { key: sessions[0].sessionKey };
  const selected = await promptForSession(sessions);
  if (selected) return { key: selected };
  return { key: sessions[0].sessionKey, notice: 'No interactive session picker available; using latest session.' };
}

export async function resolveCliSession(options: {
  command: 'chat' | 'resume' | 'fork';
  store: SessionStore;
  sessionKey?: string;
  useLast?: boolean;
  forkSource?: string;
}): Promise<CliSessionResolution> {
  if (options.command === 'chat') {
    return { sessionKey: options.sessionKey || createCliSessionKey(), forked: false };
  }

  if (options.command === 'resume') {
    const resolved = await resolveExistingSession(options.store, options.sessionKey, Boolean(options.useLast));
    if (resolved?.error) {
      return { sessionKey: resolved.key, forked: false, error: resolved.error };
    }
    if (!resolved) {
      const sessionKey = options.sessionKey || createCliSessionKey();
      return {
        sessionKey,
        forked: false,
        notice: `No saved sessions found; starting a new session: ${sessionKey}`,
      };
    }
    return {
      sessionKey: resolved.key,
      forked: false,
      notice: resolved.notice || `Resuming session: ${resolved.key}`,
    };
  }

  const source = await resolveExistingSession(options.store, options.forkSource || options.sessionKey, Boolean(options.useLast));
  if (source?.error) {
    return { sessionKey: source.key, forked: true, error: source.error };
  }
  if (!source) {
    const fallback = `cli-fork-${timestampForKey()}-${randomUUID().slice(0, 8)}`;
    return {
      sessionKey: fallback,
      forked: true,
      notice: `No saved sessions found; starting empty fork: ${fallback}`,
    };
  }
  const messages = await options.store.loadMessages(source.key);
  // Second-precision timestamps collide when two forks land in the same second;
  // the random suffix (mirroring createCliSessionKey) keeps rapid forks distinct
  // so one long-task branch never silently overwrites another.
  const forkKey = `cli-fork-${timestampForKey()}-${randomUUID().slice(0, 8)}`;
  await options.store.replaceMessages(forkKey, messages);
  return {
    sessionKey: forkKey,
    sourceSessionKey: source.key,
    forked: true,
    notice: `Forked ${source.key} -> ${forkKey}`,
  };
}
