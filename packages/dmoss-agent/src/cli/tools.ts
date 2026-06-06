import type { MemoryManager } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import { validateMemoryWriteContent } from '../core/memory/memory.js';

export function createMemoryTools(memoryManager: MemoryManager): Tool[] {
  const memoryRead: Tool = {
    name: 'memory_read',
    description:
      'Search long-term memory (persists across sessions) for relevant entries — user preferences, past decisions, project/device facts, prior solutions. The <dmoss_memory> session digest is only an overview; use this to retrieve specifics. Returns each match with its id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords or natural language)' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' },
      },
      required: ['query'],
    },
    async execute(input) {
      const results = await memoryManager.search(input.query, input.limit || 5);
      if (results.length === 0) return 'No matching memories found.';
      return results
        .map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(2)}, id: ${r.entry.id}) ${r.snippet}`)
        .join('\n\n');
    },
  };

  const memoryWrite: Tool = {
    name: 'memory_write',
    description:
      'Save a durable fact for future sessions — a user preference, key decision, project/device constraint, or hard-won solution. One fact per call; check the <dmoss_memory> digest first to avoid duplicates. Not for transient details or secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or preference to remember' },
      },
      required: ['content'],
    },
    async execute(input) {
      const validation = validateMemoryWriteContent(input.content);
      if (!validation.ok) return `Memory write rejected: ${validation.reason}`;
      const id = await memoryManager.add(input.content);
      return `Stored in memory (id: ${id})`;
    },
  };

  const memoryDelete: Tool = {
    name: 'memory_delete',
    description: 'Delete a specific memory entry by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory entry ID to delete' },
      },
      required: ['id'],
    },
    async execute(input) {
      const deleted = await memoryManager.delete(input.id);
      return deleted ? `Deleted memory ${input.id}` : `Memory ${input.id} not found`;
    },
  };

  return [memoryRead, memoryWrite, memoryDelete];
}
