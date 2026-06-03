import type { SyntaxNode } from "../parsing/cast.js"
import type {
  CastIndex,
  ChunkingOptions,
  ChunkRecord,
  DiagnosticRecord,
  FileRecord,
  SymbolRecord,
} from "../shared/types.js"

interface ScannerFileResult {
  file: FileRecord
  chunks: Record<string, ChunkRecord>
  symbols: Record<string, SymbolRecord>
}

interface ScannerStore {
  read(): Promise<CastIndex>
  write(index: CastIndex): Promise<void>
  beginIndexRun?(input: { configHash: string; metadata: CastIndex["metadata"] }): Promise<{ runId: string }>
  getCompletedFile?(runId: string, filePath: string, fingerprint: string): Promise<ScannerFileResult | undefined>
  writeFileResult?(runId: string, fileResult: ScannerFileResult): Promise<void>
  writeFileResults?(runId: string, fileResults: ScannerFileResult[]): Promise<void>
  activateRun?(runId: string, index: CastIndex): Promise<void>
}

interface CreateIndexerInput {
  worktree: string
  options: {
    maxChunkNonWhitespaceChars: number
    maxFileBytes: number
    includeGlobs: string[]
    excludeGlobs: string[]
    chunking: ChunkingOptions
    embeddingBatchSize?: number
    embeddingBatchConcurrency?: number
  }
  store: ScannerStore
  parse(filePath: string, source: string): Promise<{ language: string; root?: SyntaxNode }>
  embed(text: string, signal?: AbortSignal): Promise<number[]>
  embedBatch?(texts: string[], signal?: AbortSignal): Promise<number[][]>
}

type IndexRunStore = ScannerStore &
  Required<Pick<ScannerStore, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">>
type SymbolsByFilePath = Map<string, SymbolRecord[]>

interface RefreshState {
  nextFiles: CastIndex["files"]
  nextChunks: CastIndex["chunks"]
  nextSymbols: CastIndex["symbols"]
  symbolsByFilePath: SymbolsByFilePath
  metadataDiagnostics: string[]
  metadataDiagnosticDetails: DiagnosticRecord[]
  reusedFileResults: ScannerFileResult[]
  canReuseExistingRecords: boolean
  reusedRecordsChanged: boolean
  changed: boolean
}

interface LoadedFile {
  fingerprint: string
  text: string
}

interface FileStatMetadata {
  sizeBytes: number
  mtimeMs: number
  ctimeMs: number
}

type EmbeddingResult = { embedding: number[] } | { embeddingError: string }

interface EmbeddingBatcher {
  embed(text: string): Promise<EmbeddingResult>
  drain(): Promise<void>
}

interface FileResultWriter {
  add(fileResult: ScannerFileResult): Promise<void>
  flush(): Promise<void>
}

export type {
  CreateIndexerInput,
  EmbeddingBatcher,
  EmbeddingResult,
  FileResultWriter,
  FileStatMetadata,
  IndexRunStore,
  LoadedFile,
  RefreshState,
  ScannerFileResult,
  ScannerStore,
  SymbolsByFilePath,
}
