import fs from "node:fs/promises";
import {
  CURRENT_SESSION_VERSION,
  type CompactionEntry,
  type Message,
  type MessageEntry,
  type SessionEntry,
  type SessionHeaderEntry,
} from './session-jsonl-types.js';

// ============== CRC8 Line Checksum ==============

/**
 * CRC8 lookup table (polynomial 0x07, standard CRC-8).
 * Used to detect bit-rot and partial writes in JSONL lines.
 */
const CRC8_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) : (crc << 1);
  }
  CRC8_TABLE[i] = crc & 0xff;
}

function crc8(data: string): string {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC8_TABLE[crc ^ data.charCodeAt(i)] ?? 0;
  }
  return crc.toString(16).padStart(2, '0');
}

/** Format a JSONL line with its CRC8 checksum (tab-separated). */
export function formatJsonlLine(entry: unknown): string {
  const json = JSON.stringify(entry);
  return `${json}\t${crc8(json)}`;
}

function isSessionHeader(value: unknown): value is SessionHeaderEntry {
  if (!value || typeof value !== "object") return false;
  const header = value as SessionHeaderEntry;
  return header.type === "session" && typeof header.id === "string";
}

function isLegacyMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const msg = value as Message;
  if (msg.role !== "user" && msg.role !== "assistant") return false;
  if (!("content" in msg)) return false;
  return typeof msg.timestamp === "number";
}

function parseJsonlLines(content: string): unknown[] {
  const entries: unknown[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    // Check for CRC suffix (tab-separated): `{json}\t{crc8}`
    const tabIndex = raw.lastIndexOf("\t");
    let jsonStr = raw;
    if (tabIndex > 0) {
      const candidateJson = raw.slice(0, tabIndex);
      const candidateCrc = raw.slice(tabIndex + 1).trim();
      if (/^[0-9a-f]{2}$/.test(candidateCrc)) {
        if (crc8(candidateJson) === candidateCrc) {
          jsonStr = candidateJson;
        } else {
          // CRC present but invalid — line is corrupted, skip it
          console.warn("skipping CRC-invalid JSONL line", { lineIndex: i, lineLength: raw.length });
          continue;
        }
      }
      // Not a valid CRC suffix → treat entire line as legacy (no CRC) JSON
    }

    try {
      entries.push(JSON.parse(jsonStr));
    } catch {
      // Skip corrupted lines but log for diagnostics
      console.warn("skipping corrupted JSONL line", { lineIndex: i, lineLength: raw.length });
    }
  }
  return entries;
}

export async function loadSessionFile(
  filePath: string,
): Promise<{ header?: SessionHeaderEntry; entries: SessionEntry[]; legacyMessages?: Message[] }> {
  const content = await fs.readFile(filePath, "utf-8");
  const rawEntries = parseJsonlLines(content);

  if (rawEntries.length === 0) {
    return { entries: [] };
  }

  const [first, ...rest] = rawEntries;
  if (!isSessionHeader(first)) {
    const messages = rawEntries.filter(isLegacyMessage);
    return { entries: [], legacyMessages: messages };
  }

  const header: SessionHeaderEntry = {
    ...first,
    version: typeof first.version === "number" ? first.version : CURRENT_SESSION_VERSION,
  };
  const entries: SessionEntry[] = [];

  for (const entry of rest) {
    if (!entry || typeof entry !== "object") continue;
    const typed = entry as SessionEntry;
    if (!typed.type || typeof typed.id !== "string") continue;
    if (typed.type === "message" && (typed as MessageEntry).message) {
      entries.push(typed);
      continue;
    }
    if (
      typed.type === "compaction" &&
      typeof (typed as CompactionEntry).summary === "string" &&
      typeof (typed as CompactionEntry).firstKeptEntryId === "string"
    ) {
      entries.push(typed);
    }
  }

  return { header, entries };
}
