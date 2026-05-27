import type { MemoryManager } from '../core/index.js';
import type { Tool } from '../core/tools/tool-types.js';
import { validateMemoryWriteContent } from '../core/memory/memory.js';

export function createMemoryTools(memoryManager: MemoryManager): Tool[] {
  const memoryRead: Tool = {
    name: 'memory_read',
    description:
      'Search long-term memory for relevant entries. Use to recall user preferences, past decisions, or stored facts.',
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
        .map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(2)}) ${r.snippet}`)
        .join('\n\n');
    },
  };

  const memoryWrite: Tool = {
    name: 'memory_write',
    description:
      'Store an important fact, user preference, or decision in long-term memory for future recall.',
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
