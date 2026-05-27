# @dmoss/memory

Context-aware memory management for the Moss agent runtime.

## Features

- **BM25 + Embedding Hybrid Search**: Combines keyword-based BM25 scoring with semantic embedding similarity for robust memory retrieval
- **Scope-based Organization**: Memories organized by workspace, user, device, and learning scopes
- **Self-learning Memory**: Automatic extraction and storage of user preferences and corrections
- **Cross-language Recall**: Query in one language, retrieve memories stored in another
- **Staleness Management**: Automatic detection and decay of stale memories

## Installation

```bash
npm install @dmoss/memory
```

## Usage

```typescript
import { MemoryManager } from '@dmoss/memory';

const memory = new MemoryManager('./.dmoss/memory', optionalEmbeddingProvider);

// Store a memory
await memory.add('User prefers TypeScript over JavaScript', {
  scope: 'user',
  pinned: true,
});

// Search memories
const results = await memory.search('programming language preference', {
  scope: 'user',
  limit: 5,
});

// Load context for agent
await memory.loadContext();
```

## API

- `MemoryManager`: Main memory storage and retrieval
- `MemoryContextSelector`: Context-aware memory selection for agent turns
- `SelfLearningMemory`: Automatic preference and correction extraction
- `WorkspaceMemory`: Workspace-level memory management

## License

MIT
