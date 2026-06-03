import type { ChunkingOptions } from "../shared/types.js"
import { buildEmptyIndex } from "./empty-index.js"
import { createSqliteIndexStore } from "./sqlite.js"
import { rankVectorsByCosine, storeCosineSimilarity } from "./vector-search.js"

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
