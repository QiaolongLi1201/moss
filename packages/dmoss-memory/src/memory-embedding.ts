export interface MemoryEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export interface EmbeddedMemoryEntry {
  id: string;
  embedding: number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function hybridScore(
  keywordScore: number,
  semanticScore: number,
  semanticWeight: number = 0.3,
): number {
  return keywordScore * (1 - semanticWeight) + semanticScore * semanticWeight;
}
