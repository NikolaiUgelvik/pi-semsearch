export type SourceRange = {
  byteStart: number
  byteEnd: number
  lineStart: number
  lineEnd: number
}

export type ChunkKind = "file" | "class" | "function" | "method" | "block" | "fallback"

export type ChunkRecord = {
  id: string
  filePath: string
  language: string
  kind: ChunkKind
  range: SourceRange
  text: string
  nonWhitespaceChars: number
  nodeTypes: string[]
  symbolIds: string[]
  parentChunkId?: string
  childChunkIds: string[]
  previousSiblingChunkId?: string
  nextSiblingChunkId?: string
  embedding?: number[]
  embeddingError?: string
}

export type SymbolRecord = {
  id: string
  name: string
  kind: "module" | "class" | "function" | "method" | "interface"
  filePath: string
  range: SourceRange
  parentSymbolId?: string
  childSymbolIds: string[]
}

export type FileRecord = {
  path: string
  language: string
  fingerprint: string
  chunkIds: string[]
  diagnostics: string[]
}

export type IndexMetadata = {
  schemaVersion: number
  projectId: string
  worktree: string
  cacheKey: string
  embeddingModel?: string
  embeddingDimensions?: number
  maxChunkNonWhitespaceChars: number
  updatedAt: number
  status: "empty" | "indexing" | "ready" | "stale" | "error"
  diagnostics: string[]
}

export type CastIndex = {
  metadata: IndexMetadata
  files: Record<string, FileRecord>
  chunks: Record<string, ChunkRecord>
  symbols: Record<string, SymbolRecord>
}

export type SearchInput = {
  query: string
  topK?: number
  maxContextChars?: number
  includeParents?: boolean
  refresh?: boolean
  paths?: string[]
}

export type SearchResult = {
  filePath: string
  language: string
  range: SourceRange
  score: number
  finalScore: number
  kind: ChunkKind
  breadcrumbs: string[]
  text: string
  parentText?: string
  parentRange?: SourceRange
  topology: {
    chunkId: string
    parentChunkId?: string
    childChunkIds: string[]
    previousSiblingChunkId?: string
    nextSiblingChunkId?: string
    symbolIds: string[]
  }
}

export type SearchOutput = {
  status: IndexMetadata & { hydeUsed: boolean; bestScore?: number }
  results: SearchResult[]
  diagnostics: string[]
}
