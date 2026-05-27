export {
  MemoryManager,
  MEMORY_INDEX_CHAR_SOFT_LIMIT,
  LEARNING_TOPIC_SLUGS,
  buildMemorySearchQueryVariants,
  validateMemoryWriteContent,
  type LearningTopicSlug,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchResult,
  type MemorySource,
  type MemoryWriteValidation,
} from "./memory-manager.js";

export {
  WorkspaceMemory,
  type WorkspaceMemoryConfig,
  type WorkspaceMemoryContext,
} from "./workspace-memory.js";

export {
  selectMemoriesForContext,
  renderMemoryPicksForSystemPrompt,
  type SelectMemoryForContextParams,
  type MemoryContextPick,
} from "./memory-context-selector.js";

export {
  buildSelfLearningMemoryDraft,
  type SelfLearningMemoryDraft,
} from "./self-learning-memory.js";

export { cosineSimilarity, hybridScore } from './memory-embedding.js';
export type { MemoryEmbeddingProvider, EmbeddedMemoryEntry } from './memory-embedding.js';
