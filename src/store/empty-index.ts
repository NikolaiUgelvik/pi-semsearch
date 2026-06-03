import type { CastIndex, ChunkingOptions } from "../shared/types.js"

const INDEX_SCHEMA_VERSION = 1
const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  overlap: 0,
  expansion: false,
  minSemanticNonWhitespaceChars: 8,
}

function buildEmptyIndex(input: {
  projectId: string
  worktree: string
  cacheKey: string
  maxChunkNonWhitespaceChars: number
  chunking?: ChunkingOptions
  diagnostics?: string[]
}): CastIndex {
  return {
    metadata: {
      schemaVersion: INDEX_SCHEMA_VERSION,
      projectId: input.projectId,
      worktree: input.worktree,
      cacheKey: input.cacheKey,
      maxChunkNonWhitespaceChars: input.maxChunkNonWhitespaceChars,
      chunking: input.chunking ?? DEFAULT_CHUNKING_OPTIONS,
      updatedAt: Date.now(),
      status: "empty",
      diagnostics: input.diagnostics ?? [],
    },
    files: {},
    chunks: {},
    symbols: {},
  }
}
function createEmptySqliteIndex(cacheKey: string, embeddingDimensions?: number, diagnostics?: string[]) {
  const index = buildEmptyIndex({
    projectId: cacheKey,
    worktree: "",
    cacheKey,
    maxChunkNonWhitespaceChars: 2000,
    diagnostics,
  })
  if (embeddingDimensions !== undefined) {
    index.metadata.embeddingDimensions = embeddingDimensions
  }
  return index
}

export { buildEmptyIndex, createEmptySqliteIndex, INDEX_SCHEMA_VERSION }
