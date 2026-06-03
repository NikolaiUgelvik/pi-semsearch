import { buildEmptyIndex } from "./store-index.js"
import { createSqliteIndexStore } from "./store-sqlite.js"
import { rankVectorsByCosine, storeCosineSimilarity } from "./store-vector-search.js"
import type { ChunkingOptions } from "./types.js"

function createEmptyIndex(input: {
  projectId: string
  worktree: string
  cacheKey: string
  maxChunkNonWhitespaceChars: number
  chunking?: ChunkingOptions
  diagnostics?: string[]
}) {
  return buildEmptyIndex(input)
}

function createIndexStore(input: { cacheDir: string; cacheKey: string; embeddingDimensions?: number }) {
  return createSqliteIndexStore(input.cacheDir, input.cacheKey, input.embeddingDimensions)
}

function cosineSimilarity(left: number[], right: number[]) {
  return storeCosineSimilarity(left, right)
}

function searchVectors(query: number[], vectors: Array<{ id: string; vector: number[] }>, topK: number) {
  return rankVectorsByCosine(query, vectors, topK)
}

export { cosineSimilarity, createEmptyIndex, createIndexStore, searchVectors }
