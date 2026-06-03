import type { SqliteDatabase as Database } from "./store-db.js"
import type { ChunkRecord, DiagnosticRecord, FileRecord, SymbolRecord } from "./types.js"

class CorruptIndexError extends Error {
  constructor(cause?: unknown) {
    super("corrupt persisted index", { cause })
    this.name = "CorruptIndexError"
  }
}

interface FileResult {
  file: FileRecord
  chunks: Record<string, ChunkRecord>
  symbols: Record<string, SymbolRecord>
}

interface StoreHydrateChunksOptions {
  includeLexical?: boolean
}

interface HydrateSqliteChunksInput {
  db: Database
  cacheKey: string
  embeddingDimensions?: number
  chunkIds: string[]
  options?: StoreHydrateChunksOptions
}

type StoredChunkRecord = Omit<ChunkRecord, "text" | "embedding"> & { text?: never; embedding?: never }

interface SourceHydrationContext {
  worktree: string
  files: Record<string, FileRecord>
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  filePaths?: Set<string>
}

type SourceReadResult = { ok: true; bytes: Buffer } | { ok: false }

function chunkForStorage(chunk: ChunkRecord): StoredChunkRecord {
  const { text: _text, embedding: _embedding, ...storedChunk } = chunk
  return storedChunk
}

export type {
  FileResult as StoreFileResult,
  HydrateSqliteChunksInput,
  SourceHydrationContext,
  SourceReadResult,
  StoredChunkRecord,
  StoreHydrateChunksOptions,
}
export { CorruptIndexError, chunkForStorage }
