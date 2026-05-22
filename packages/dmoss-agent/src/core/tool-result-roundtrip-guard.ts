import type { ContentBlock, Message } from "./session-jsonl.js";

const SYNTHETIC_TOOL_RESULT_TEXT =
  "[dmoss-agent] missing tool_result was repaired before upstream call to keep tool_use/tool_result pairing consistent.";
const SYNTHETIC_TOOL_USE_NAME = "repaired_missing_tool_use";

function extractToolUses(msg: Message): Array<{ id: string; name?: string }> {
  if (msg.role !== "assistant" || typeof msg.content === "string") return [];
  const out: Array<{ id: string; name?: string }> = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.id) {
      out.push({ id: block.id, name: block.name });
    }
  }
  return out;
}

function buildSyntheticResultBlock(id: string, name?: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: id,
    name,
    content: SYNTHETIC_TOOL_RESULT_TEXT,
  };
}

function buildSyntheticToolUseMessage(resultBlock: ContentBlock, timestamp: number): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: resultBlock.tool_use_id ?? "",
        name: resultBlock.name || SYNTHETIC_TOOL_USE_NAME,
        input: {},
      },
    ],
    timestamp,
  };
}

function buildSyntheticResultMessage(pending: Map<string, string | undefined>, timestamp: number): Message {
  const blocks: ContentBlock[] = [];
  for (const [id, name] of pending.entries()) {
    blocks.push(buildSyntheticResultBlock(id, name));
  }
  return {
    role: "user",
    content: blocks,
    timestamp,
  };
}

export interface ToolResultRoundtripRepairResult {
  messages: Message[];
  changed: boolean;
  insertedCount: number;
  synthesizedToolUseCount: number;
  /** Orphan result ids repaired by synthesizing the missing assistant tool_use. */
  orphanResultIds: string[];
}

/**
 * Repairs broken tool_use/tool_result pairing in-memory before a provider call.
 *
 * Some context transforms (compaction / stale-read / tail-snip) are safe by
 * design, but historical transcripts can still contain dangling tool_use ids
 * after interrupted runs. Historical or packaged transcripts can also contain
 * orphan tool_result blocks when a prior transform/build lost the matching
 * assistant tool_use. This guard repairs both directions in-memory so upstream
 * providers do not reject the turn with malformed tool context.
 */
export function repairMissingToolResults(messages: Message[]): ToolResultRoundtripRepairResult {
  if (messages.length === 0) {
    return { messages, changed: false, insertedCount: 0, synthesizedToolUseCount: 0, orphanResultIds: [] };
  }

  const out: Message[] = [];
  const pending = new Map<string, string | undefined>();
  const orphanResultIds = new Set<string>();
  let insertedCount = 0;
  let synthesizedToolUseCount = 0;

  const flushPending = (ts: number) => {
    if (pending.size === 0) return;
    out.push(buildSyntheticResultMessage(pending, ts));
    insertedCount += pending.size;
    pending.clear();
  };

  const pushUserBlocks = (blocks: ContentBlock[], timestamp: number) => {
    if (blocks.length === 0) return;
    out.push({
      role: "user",
      content: blocks,
      timestamp,
    });
  };

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      let userBlocks: ContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          if (pending.has(block.tool_use_id)) {
            pending.delete(block.tool_use_id);
            userBlocks.push(block);
            continue;
          }
          orphanResultIds.add(block.tool_use_id);
          pushUserBlocks(userBlocks, msg.timestamp);
          userBlocks = [];
          out.push(buildSyntheticToolUseMessage(block, msg.timestamp));
          pushUserBlocks([block], msg.timestamp);
          synthesizedToolUseCount++;
          continue;
        }

        if (pending.size > 0) {
          pushUserBlocks(userBlocks, msg.timestamp);
          userBlocks = [];
          flushPending(msg.timestamp);
        }
        userBlocks.push(block);
      }
      pushUserBlocks(userBlocks, msg.timestamp);
      continue;
    }

    if (pending.size > 0) {
      flushPending(msg.timestamp);
    }

    out.push(msg);

    const uses = extractToolUses(msg);
    if (uses.length > 0) {
      if (pending.size > 0) {
        flushPending(msg.timestamp);
      }
      for (const u of uses) {
        pending.set(u.id, u.name);
      }
    }
  }

  if (pending.size > 0) {
    const lastTs = out[out.length - 1]?.timestamp ?? Date.now();
    flushPending(lastTs);
  }

  const changed = insertedCount > 0 || synthesizedToolUseCount > 0;
  return changed
    ? {
        messages: out,
        changed: true,
        insertedCount,
        synthesizedToolUseCount,
        orphanResultIds: [...orphanResultIds],
      }
    : {
        messages,
        changed: false,
        insertedCount: 0,
        synthesizedToolUseCount: 0,
        orphanResultIds: [...orphanResultIds],
      };
}
