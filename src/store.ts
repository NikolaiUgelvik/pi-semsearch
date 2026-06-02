import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { load as loadSqliteVec } from "sqlite-vec"
import { tokenizeCodeText } from "./lexical.js"
import { type CompiledPathFilters, compilePathFilters } from "./path-filter.js"
import type {
  CastIndex,
  ChunkingOptions,
  ChunkRecord,
  DiagnosticRecord,
  FileRecord,
  HydratedChunkSet,
  LexicalChunkCandidate,
  LexicalIndex,
  RankedChunkCandidate,
  SymbolRecord,
  VectorCandidateSearchResult,
} from "./types.js"

const INDEX_SCHEMA_VERSION = 1
const SQLITE_SCHEMA_VERSION = 4
const RUN_ID_RANDOM_RADIX = 36
const SQLITE_VECTOR_MAX_K = 4096
const SQLITE_VECTOR_PATH_FILTER_INITIAL_K = 100
const SQLITE_VECTOR_PATH_FILTER_MAX_K = SQLITE_VECTOR_MAX_K
const SQLITE_LEXICAL_PATH_FILTER_MULTIPLIER = 10
const SQLITE_LEXICAL_PATH_FILTER_MAX_K = 1000
const SQLITE_LEXICAL_FALLBACK_QUERY_TERMS = 16
const INDEX_STATUSES: readonly unknown[] = ["empty", "indexing", "ready", "stale", "error"]
const CHUNK_KINDS: readonly unknown[] = ["file", "class", "function", "method", "block", "fallback"]
const SYMBOL_KINDS: readonly unknown[] = ["module", "class", "function", "method", "interface"]

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  overlap: 0,
  expansion: false,
  minSemanticNonWhitespaceChars: 8,
}

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

interface HydrateChunksOptions {
  includeLexical?: boolean
}

interface HydrateSqliteChunksInput {
  db: Database
  cacheKey: string
  embeddingDimensions?: number
  chunkIds: string[]
  options?: HydrateChunksOptions
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

export function createEmptyIndex(input: {
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

export function createIndexStore(input: { cacheDir: string; cacheKey: string; embeddingDimensions?: number }) {
  return createSqliteIndexStore(input.cacheDir, input.cacheKey, input.embeddingDimensions)
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The store factory intentionally exposes the SQLite store API in one object.
function createSqliteIndexStore(cacheDir: string, cacheKey: string, embeddingDimensions?: number) {
  const file = path.join(cacheDir, cacheKey, "index.sqlite")
  return {
    async read() {
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return readSqliteIndex(db, cacheKey, embeddingDimensions)
      } finally {
        db.close()
      }
    },
    async write(index: CastIndex) {
      const db = await openSqliteIndex(file, embeddingDimensions ?? inferEmbeddingDimensions(index))
      try {
        writeSqliteIndex(db, index)
      } finally {
        db.close()
      }
    },
    async readMetadata() {
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return readSqliteMetadata(db, cacheKey, embeddingDimensions)
      } finally {
        db.close()
      }
    },
    async hydrateChunks(chunkIds: string[], options?: HydrateChunksOptions) {
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return hydrateSqliteChunks({ db, cacheKey, embeddingDimensions, chunkIds, options })
      } finally {
        db.close()
      }
    },
    async searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]) {
      if (queryEmbedding.length === 0 || topK <= 0) {
        return []
      }
      const db = await openSqliteIndex(file, embeddingDimensions ?? queryEmbedding.length)
      try {
        return searchSqliteVectorCandidates(db, queryEmbedding, topK, paths)
      } finally {
        db.close()
      }
    },
    async searchLexicalCandidates(query: string, topK: number, paths?: string[]) {
      if (query.trim().length === 0 || topK <= 0) {
        return []
      }
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return searchSqliteLexicalCandidates(db, query, topK, paths)
      } finally {
        db.close()
      }
    },
    async beginIndexRun(input: { configHash: string; metadata: CastIndex["metadata"] }) {
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return beginSqliteIndexRun(db, input.configHash, input.metadata)
      } finally {
        db.close()
      }
    },
    async getCompletedFile(runId: string, filePath: string, fingerprint: string) {
      const db = await openSqliteIndex(file, embeddingDimensions)
      try {
        return getCompletedSqliteFile(db, runId, filePath, fingerprint)
      } finally {
        db.close()
      }
    },
    async writeFileResult(runId: string, fileResult: FileResult) {
      const db = await openSqliteIndex(file, embeddingDimensions ?? inferFileResultEmbeddingDimensions(fileResult))
      try {
        writeSqliteFileResult(db, runId, fileResult)
      } finally {
        db.close()
      }
    },
    async writeFileResults(runId: string, fileResults: FileResult[]) {
      const db = await openSqliteIndex(file, embeddingDimensions ?? inferFileResultsEmbeddingDimensions(fileResults))
      try {
        writeSqliteFileResults(db, runId, fileResults)
      } finally {
        db.close()
      }
    },
    async activateRun(runId: string, index: CastIndex) {
      const db = await openSqliteIndex(file, embeddingDimensions ?? inferEmbeddingDimensions(index))
      try {
        activateSqliteRun(db, runId, index)
      } finally {
        db.close()
      }
    },
  }
}

async function openSqliteIndex(file: string, embeddingDimensions?: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    loadSqliteVec(db)
    initializeSchema(db, embeddingDimensions)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function readSqliteIndex(db: Database, cacheKey: string, embeddingDimensions?: number) {
  const activeRunId = readActiveRunId(db)
  if (!activeRunId) {
    return createEmptySqliteIndex(cacheKey, embeddingDimensions)
  }

  try {
    return readActiveSqliteIndex(db, activeRunId, cacheKey, embeddingDimensions)
  } catch (error) {
    if (!(error instanceof CorruptIndexError)) {
      throw error
    }
    return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"])
  }
}

function readActiveSqliteIndex(
  db: Database,
  activeRunId: string,
  cacheKey: string,
  embeddingDimensions: number | undefined,
) {
  const metadata = readRunMetadata(db, activeRunId)
  if (!metadata) {
    return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"])
  }

  const index = buildSqliteIndex(db, activeRunId, metadata)
  return isCastIndex(index)
    ? index
    : createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"])
}

function buildSqliteIndex(db: Database, activeRunId: string, metadata: CastIndex["metadata"]) {
  const files = readFiles(db, activeRunId)
  const diagnostics = [...metadata.diagnostics]
  const diagnosticDetails = [...(metadata.diagnosticDetails ?? [])]
  const index: CastIndex = {
    metadata: { ...metadata, diagnostics, diagnosticDetails },
    files,
    chunks: readChunks(db, activeRunId, readVectors(db, activeRunId), {
      worktree: metadata.worktree,
      files,
      diagnostics,
      diagnosticDetails,
    }),
    symbols: readSymbols(db, activeRunId),
  }
  const lexical = readLexical(db, activeRunId)
  if (lexical) {
    index.lexical = lexical
  }
  return index
}

function readSqliteMetadata(db: Database, cacheKey: string, embeddingDimensions?: number) {
  const activeRunId = readActiveRunId(db)
  if (!activeRunId) {
    return createEmptySqliteIndex(cacheKey, embeddingDimensions).metadata
  }

  try {
    return (
      readRunMetadata(db, activeRunId) ??
      createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata
    )
  } catch (error) {
    if (!(error instanceof CorruptIndexError)) {
      throw error
    }
    return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata
  }
}

function hydrateSqliteChunks(input: HydrateSqliteChunksInput): HydratedChunkSet {
  const { db, cacheKey, embeddingDimensions, chunkIds, options } = input
  const activeRunId = readActiveRunId(db)
  if (!activeRunId) {
    return emptyHydratedChunkSet(cacheKey, embeddingDimensions)
  }
  const metadata = readSqliteMetadata(db, cacheKey, embeddingDimensions)
  if (!metadata) {
    return emptyHydratedChunkSet(cacheKey, embeddingDimensions, ["rebuilding corrupt index"])
  }
  if (chunkIds.length === 0) {
    const hydrated: HydratedChunkSet = { metadata, files: {}, chunks: {}, symbols: {}, diagnostics: [] }
    if (options?.includeLexical) {
      const lexical = readLexical(db, activeRunId)
      if (lexical) {
        hydrated.lexical = lexical
      }
    }
    return hydrated
  }

  return hydrateActiveSqliteChunks({ db, activeRunId, metadata, chunkIds, options })
}

function hydrateActiveSqliteChunks(input: {
  db: Database
  activeRunId: string
  metadata: CastIndex["metadata"]
  chunkIds: string[]
  options?: HydrateChunksOptions
}): HydratedChunkSet {
  const { db, activeRunId, metadata, chunkIds, options } = input
  const ids = chunkIdsWithTopology(db, activeRunId, chunkIds)
  const orderedStoredChunks = orderedStoredChunksByIds(db, activeRunId, ids)
  const files = readFilesByPaths(db, activeRunId, filePathsForChunks(orderedStoredChunks))
  const diagnostics = [...metadata.diagnostics]
  const diagnosticDetails = [...(metadata.diagnosticDetails ?? [])]
  const sourceContext: SourceHydrationContext = { worktree: metadata.worktree, files, diagnostics, diagnosticDetails }
  const chunks = hydrateStoredChunks({ db, activeRunId, ids, orderedStoredChunks, sourceContext })
  const hydrated = hydratedChunkSet({ db, activeRunId, metadata, files, chunks, diagnostics, diagnosticDetails })
  if (options?.includeLexical) {
    const lexical = readLexical(db, activeRunId)
    if (lexical) {
      hydrated.lexical = lexical
    }
  }
  return hydrated
}

function orderedStoredChunksByIds(db: Database, activeRunId: string, ids: string[]) {
  const storedChunks = readStoredChunksByIds(db, activeRunId, ids)
  return ids.flatMap((chunkId) => {
    const chunk = storedChunks.get(chunkId)
    return chunk ? [chunk] : []
  })
}

function filePathsForChunks(chunks: StoredChunkRecord[]) {
  return [...new Set(chunks.map((chunk) => chunk.filePath))]
}

function hydrateStoredChunks(input: {
  db: Database
  activeRunId: string
  ids: string[]
  orderedStoredChunks: StoredChunkRecord[]
  sourceContext: SourceHydrationContext
}) {
  const sourceCache = new Map<string, SourceReadResult>()
  const vectors = readVectorsForChunkIds(input.db, input.activeRunId, input.ids)
  const chunks: Record<string, ChunkRecord> = {}

  for (const storedChunk of input.orderedStoredChunks) {
    const chunk: ChunkRecord = { ...storedChunk, text: readChunkText(input.sourceContext, sourceCache, storedChunk) }
    const embedding = vectors.get(chunk.id)
    if (embedding) {
      chunk.embedding = embedding
    }
    chunks[chunk.id] = chunk
  }
  return chunks
}

function hydratedChunkSet(input: {
  db: Database
  activeRunId: string
  metadata: CastIndex["metadata"]
  files: Record<string, FileRecord>
  chunks: Record<string, ChunkRecord>
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
}) {
  const hydrated: HydratedChunkSet = {
    metadata: { ...input.metadata, diagnostics: input.diagnostics, diagnosticDetails: input.diagnosticDetails },
    files: input.files,
    chunks: input.chunks,
    symbols: readSymbolsByIds(input.db, input.activeRunId, symbolIdsForChunks(input.chunks)),
    diagnostics: input.diagnostics,
  }
  if (input.diagnosticDetails.length > 0) {
    hydrated.diagnosticDetails = input.diagnosticDetails
  }
  return hydrated
}

function symbolIdsForChunks(chunks: Record<string, ChunkRecord>) {
  return [...new Set(Object.values(chunks).flatMap((chunk) => chunk.symbolIds))]
}

function emptyHydratedChunkSet(
  cacheKey: string,
  embeddingDimensions: number | undefined,
  diagnostics?: string[],
): HydratedChunkSet {
  return {
    metadata: createEmptySqliteIndex(cacheKey, embeddingDimensions, diagnostics).metadata,
    files: {},
    chunks: {},
    symbols: {},
    diagnostics: diagnostics ?? [],
  }
}

function chunkIdsWithTopology(db: Database, runId: string, chunkIds: string[]) {
  const selected = readStoredChunksByIds(db, runId, [...new Set(chunkIds)])
  const ids = selectedChunkIds(chunkIds, selected)
  appendRelatedChunkIds(ids, selected)
  return ids
}

function selectedChunkIds(chunkIds: string[], selected: Map<string, StoredChunkRecord>) {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const chunkId of chunkIds) {
    if (seen.has(chunkId) || !selected.has(chunkId)) {
      continue
    }
    ids.push(chunkId)
    seen.add(chunkId)
  }
  return ids
}

function appendRelatedChunkIds(ids: string[], selected: Map<string, StoredChunkRecord>) {
  const seen = new Set(ids)
  for (const chunkId of ids.slice()) {
    const chunk = selected.get(chunkId)
    if (!chunk) {
      continue
    }
    for (const relatedId of relatedChunkIds(chunk)) {
      if (relatedId && !seen.has(relatedId)) {
        ids.push(relatedId)
        seen.add(relatedId)
      }
    }
  }
}

function relatedChunkIds(chunk: StoredChunkRecord) {
  return [chunk.parentChunkId, ...chunk.childChunkIds, chunk.previousSiblingChunkId, chunk.nextSiblingChunkId]
}

function readActiveRunId(db: Database) {
  return (db.query("select value from meta where key = 'active_run_id'").get() as { value: string } | null)?.value
}

function readRunMetadata(db: Database, runId: string) {
  const run = db.query("select metadata_json as metadataJson from runs where id = ?").get(runId) as {
    metadataJson: string
  } | null
  return run ? parsePersistedJson<CastIndex["metadata"]>(run.metadataJson) : undefined
}

function createEmptySqliteIndex(cacheKey: string, embeddingDimensions?: number, diagnostics?: string[]) {
  const index = createEmptyIndex({
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

function readFiles(db: Database, runId: string) {
  return fileRecordsFromRows(
    db
      .query(
        `select file_runs.path,
                coalesce(file_runs.language, files.language) as language,
                coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
                coalesce(file_runs.size_bytes, files.size_bytes) as sizeBytes,
                coalesce(file_runs.mtime_ms, files.mtime_ms) as mtimeMs,
                coalesce(file_runs.ctime_ms, files.ctime_ms) as ctimeMs,
                coalesce(file_runs.diagnostics_json, files.diagnostics_json) as diagnosticsJson,
                file_runs.chunk_ids_json as chunkIdsJson
         from file_runs
         left join files on files.path = file_runs.path
         where file_runs.run_id = ?`,
      )
      .all(runId) as FileRow[],
  )
}

function readFilesByPaths(db: Database, runId: string, filePaths: string[]) {
  if (filePaths.length === 0) {
    return {}
  }
  const placeholders = placeholdersFor(filePaths)
  return fileRecordsFromRows(
    db
      .query(
        `select file_runs.path,
                coalesce(file_runs.language, files.language) as language,
                coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
                coalesce(file_runs.size_bytes, files.size_bytes) as sizeBytes,
                coalesce(file_runs.mtime_ms, files.mtime_ms) as mtimeMs,
                coalesce(file_runs.ctime_ms, files.ctime_ms) as ctimeMs,
                coalesce(file_runs.diagnostics_json, files.diagnostics_json) as diagnosticsJson,
                file_runs.chunk_ids_json as chunkIdsJson
         from file_runs
         left join files on files.path = file_runs.path
         where file_runs.run_id = ? and file_runs.path in (${placeholders})`,
      )
      .all(runId, ...filePaths) as FileRow[],
  )
}

interface FileRow {
  path: string
  language: string
  fingerprint: string
  sizeBytes: number | null
  mtimeMs: number | null
  ctimeMs: number | null
  diagnosticsJson: string
  chunkIdsJson: string
}

function fileRecordsFromRows(files: FileRow[]) {
  const records: Record<string, FileRecord> = {}
  for (const file of files) {
    const record: FileRecord = {
      path: file.path,
      language: file.language,
      fingerprint: file.fingerprint,
      chunkIds: parsePersistedJson(file.chunkIdsJson),
      diagnostics: parsePersistedJson(file.diagnosticsJson),
    }
    if (file.sizeBytes !== null) {
      record.sizeBytes = file.sizeBytes
    }
    if (file.mtimeMs !== null) {
      record.mtimeMs = file.mtimeMs
    }
    if (file.ctimeMs !== null) {
      record.ctimeMs = file.ctimeMs
    }
    records[file.path] = record
  }
  return records
}

function readStoredChunksByIds(db: Database, runId: string, chunkIds: string[]) {
  const records = new Map<string, StoredChunkRecord>()
  if (chunkIds.length === 0) {
    return records
  }
  const placeholders = placeholdersFor(chunkIds)
  const chunks = db
    .query(`select id, record_json as recordJson from chunks where run_id = ? and id in (${placeholders})`)
    .all(runId, ...chunkIds) as Array<{ id: string; recordJson: string }>
  for (const chunk of chunks) {
    records.set(chunk.id, parsePersistedJson<StoredChunkRecord>(chunk.recordJson))
  }
  return records
}

function readVectors(db: Database, runId: string) {
  const vectors = new Map<string, number[]>()
  if (!tableExists(db, "chunk_vectors")) {
    return vectors
  }
  const vectorRows = db
    .query(
      "select chunk_rowids.chunk_id as chunkId, vec_to_json(chunk_vectors.embedding) as embedding from chunk_rowids inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid where chunk_rowids.run_id = ?",
    )
    .all(runId) as Array<{ chunkId: string; embedding: string }>
  for (const row of vectorRows) {
    vectors.set(row.chunkId, parsePersistedJson(row.embedding))
  }
  return vectors
}

function readVectorsForChunkIds(db: Database, runId: string, chunkIds: string[]) {
  const vectors = new Map<string, number[]>()
  if (chunkIds.length === 0 || !tableExists(db, "chunk_vectors")) {
    return vectors
  }
  const placeholders = placeholdersFor(chunkIds)
  const vectorRows = db
    .query(
      `select chunk_rowids.chunk_id as chunkId, vec_to_json(chunk_vectors.embedding) as embedding
       from chunk_rowids
       inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
       where chunk_rowids.run_id = ? and chunk_rowids.chunk_id in (${placeholders})`,
    )
    .all(runId, ...chunkIds) as Array<{ chunkId: string; embedding: string }>
  for (const row of vectorRows) {
    vectors.set(row.chunkId, parsePersistedJson(row.embedding))
  }
  return vectors
}

function readChunks(
  db: Database,
  runId: string,
  vectors: Map<string, number[]>,
  sourceContext?: SourceHydrationContext,
) {
  const records: Record<string, ChunkRecord> = {}
  const sourceCache = new Map<string, SourceReadResult>()
  const chunks = db.query("select id, record_json as recordJson from chunks where run_id = ?").all(runId) as Array<{
    id: string
    recordJson: string
  }>
  for (const chunk of chunks) {
    const storedRecord = parsePersistedJson<StoredChunkRecord>(chunk.recordJson)
    if (sourceContext?.filePaths && !sourceContext.filePaths.has(storedRecord.filePath)) {
      continue
    }
    const record: ChunkRecord = {
      ...storedRecord,
      text: readChunkText(sourceContext, sourceCache, storedRecord),
    }
    const embedding = vectors.get(chunk.id)
    if (embedding) {
      record.embedding = embedding
    }
    records[chunk.id] = record
  }
  return records
}

function readFileChunks(input: {
  db: Database
  runId: string
  file: FileRecord
  vectors: Map<string, number[]>
  sourceContext: SourceHydrationContext
}) {
  const records: Record<string, ChunkRecord> = {}
  if (input.file.chunkIds.length === 0) {
    return records
  }
  const sourceCache = new Map<string, SourceReadResult>()
  const placeholders = placeholdersFor(input.file.chunkIds)
  const chunks = input.db
    .query(
      `select id, record_json as recordJson
       from chunks
       where run_id = ? and file_path = ? and id in (${placeholders})`,
    )
    .all(input.runId, input.file.path, ...input.file.chunkIds) as Array<{
    id: string
    recordJson: string
  }>
  for (const chunk of chunks) {
    const storedRecord = parsePersistedJson<StoredChunkRecord>(chunk.recordJson)
    const record: ChunkRecord = {
      ...storedRecord,
      text: readChunkText(input.sourceContext, sourceCache, storedRecord),
    }
    const embedding = input.vectors.get(chunk.id)
    if (embedding) {
      record.embedding = embedding
    }
    records[chunk.id] = record
  }
  return records
}

function readChunkText(
  sourceContext: SourceHydrationContext | undefined,
  sourceCache: Map<string, SourceReadResult>,
  chunk: StoredChunkRecord,
) {
  if (!sourceContext) {
    return ""
  }
  const source = readSource(sourceContext, sourceCache, chunk.filePath)
  if (!source.ok) {
    return ""
  }
  if (
    chunk.range.byteStart < 0 ||
    chunk.range.byteEnd < chunk.range.byteStart ||
    chunk.range.byteEnd > source.bytes.length
  ) {
    addSourceHydrationDiagnostic(sourceContext, {
      code: "source.mismatch",
      filePath: chunk.filePath,
      chunkId: chunk.id,
      message: `source range invalid for ${chunk.filePath}:${chunk.id}; chunk text unavailable`,
    })
    return ""
  }
  return source.bytes.subarray(chunk.range.byteStart, chunk.range.byteEnd).toString()
}

function readSource(
  sourceContext: SourceHydrationContext,
  sourceCache: Map<string, SourceReadResult>,
  filePath: string,
): SourceReadResult {
  const cached = sourceCache.get(filePath)
  if (cached) {
    return cached
  }
  const result = readSourceUncached(sourceContext, filePath)
  sourceCache.set(filePath, result)
  return result
}

function readSourceUncached(sourceContext: SourceHydrationContext, filePath: string): SourceReadResult {
  try {
    const bytes = readFileSync(path.join(sourceContext.worktree, filePath))
    if (fingerprint(bytes) !== sourceContext.files[filePath]?.fingerprint) {
      addSourceHydrationDiagnostic(sourceContext, {
        code: "source.mismatch",
        filePath,
        message: `source fingerprint mismatch for ${filePath}; chunk text unavailable`,
      })
      return { ok: false }
    }
    return { ok: true, bytes }
  } catch {
    addSourceHydrationDiagnostic(sourceContext, {
      code: "source.read_failed",
      filePath,
      message: `source read failed for ${filePath}; chunk text unavailable`,
    })
    return { ok: false }
  }
}

function addSourceHydrationDiagnostic(sourceContext: SourceHydrationContext, detail: DiagnosticRecord) {
  sourceContext.diagnostics.push(detail.message)
  sourceContext.diagnosticDetails.push(detail)
}

function fingerprint(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function readSymbols(db: Database, runId: string) {
  const records: Record<string, SymbolRecord> = {}
  const symbols = db.query("select id, record_json as recordJson from symbols where run_id = ?").all(runId) as Array<{
    id: string
    recordJson: string
  }>
  for (const symbol of symbols) {
    records[symbol.id] = parsePersistedJson(symbol.recordJson)
  }
  return records
}

function readSymbolsByIds(db: Database, runId: string, symbolIds: string[]) {
  const records: Record<string, SymbolRecord> = {}
  if (symbolIds.length === 0) {
    return records
  }
  const placeholders = placeholdersFor(symbolIds)
  const symbols = db
    .query(`select id, record_json as recordJson from symbols where run_id = ? and id in (${placeholders})`)
    .all(runId, ...symbolIds) as Array<{
    id: string
    recordJson: string
  }>
  for (const symbol of symbols) {
    records[symbol.id] = parsePersistedJson(symbol.recordJson)
  }
  return records
}

function readSymbolsForFile(db: Database, runId: string, filePath: string) {
  const records: Record<string, SymbolRecord> = {}
  const symbols = db
    .query("select id, record_json as recordJson from symbols where run_id = ? and file_path = ?")
    .all(runId, filePath) as Array<{
    id: string
    recordJson: string
  }>
  for (const symbol of symbols) {
    records[symbol.id] = parsePersistedJson(symbol.recordJson)
  }
  return records
}

function placeholdersFor(values: unknown[]) {
  return values.map(() => "?").join(", ")
}

function readLexical(db: Database, runId: string) {
  const lexical = db.query("select metadata_json as metadataJson from lexical where run_id = ?").get(runId) as {
    metadataJson: string
  } | null
  return lexical ? parsePersistedJson<LexicalIndex>(lexical.metadataJson) : undefined
}

function parsePersistedJson<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T
  } catch (error) {
    throw new CorruptIndexError(error)
  }
}

function writeSqliteIndex(db: Database, index: CastIndex) {
  const runId = `ready-${Date.now()}`
  const write = db.transaction((castIndex: CastIndex) => {
    clearSqliteIndex(db)
    insertRun(db, runId, castIndex)

    for (const file of Object.values(castIndex.files)) {
      insertFile(db, runId, file)
    }

    insertChunksWithVectorRowids(db, runId, Object.values(castIndex.chunks), 1)

    for (const symbol of Object.values(castIndex.symbols)) {
      insertSymbol(db, runId, symbol)
    }

    if (castIndex.lexical) {
      insertLexical(db, runId, castIndex.lexical)
    }
    db.run("insert or replace into meta (key, value) values ('active_run_id', ?)", [runId])
  })

  write(index)
}

function beginSqliteIndexRun(db: Database, configHash: string, metadata: CastIndex["metadata"]) {
  const existing = db
    .query("select id from runs where status = 'indexing' and config_hash = ? order by started_at desc limit 1")
    .get(configHash) as { id: string } | null
  if (existing) {
    return { runId: existing.id }
  }

  const runId = `indexing-${Date.now()}-${Math.random().toString(RUN_ID_RANDOM_RADIX).slice(2)}`
  db.run(
    "insert into runs (id, status, config_hash, started_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?)",
    [
      runId,
      "indexing",
      configHash,
      Date.now(),
      null,
      JSON.stringify({ ...metadata, status: "indexing", updatedAt: Date.now() }),
    ],
  )
  return { runId }
}

function getCompletedSqliteFile(
  db: Database,
  runId: string,
  filePath: string,
  fingerprint: string,
): FileResult | undefined {
  const file = db
    .query(
      `select path, language, fingerprint, size_bytes as sizeBytes, mtime_ms as mtimeMs, ctime_ms as ctimeMs, diagnostics_json as diagnosticsJson, chunk_ids_json as chunkIdsJson
       from file_runs
       where run_id = ? and path = ? and fingerprint = ?`,
    )
    .get(runId, filePath, fingerprint) as {
    path: string
    language: string
    fingerprint: string
    sizeBytes: number | null
    mtimeMs: number | null
    ctimeMs: number | null
    diagnosticsJson: string
    chunkIdsJson: string
  } | null
  if (!file) {
    return
  }

  const record: FileRecord = {
    path: file.path,
    language: file.language,
    fingerprint: file.fingerprint,
    sizeBytes: file.sizeBytes ?? undefined,
    mtimeMs: file.mtimeMs ?? undefined,
    ctimeMs: file.ctimeMs ?? undefined,
    chunkIds: JSON.parse(file.chunkIdsJson),
    diagnostics: JSON.parse(file.diagnosticsJson),
  }
  const metadata = readRunMetadata(db, runId)
  if (!metadata) {
    return
  }
  const diagnostics: string[] = []
  const diagnosticDetails: DiagnosticRecord[] = []
  const chunks = readFileChunks({
    db,
    runId,
    file: record,
    vectors: readVectorsForChunkIds(db, runId, record.chunkIds),
    sourceContext: {
      worktree: metadata.worktree,
      files: { [record.path]: record },
      diagnostics,
      diagnosticDetails,
      filePaths: new Set([record.path]),
    },
  })
  if (diagnostics.length > 0) {
    return
  }
  return {
    file: record,
    chunks: Object.fromEntries(record.chunkIds.map((id) => [id, chunks[id]]).filter((entry) => entry[1])),
    symbols: readSymbolsForFile(db, runId, filePath),
  }
}

function writeSqliteFileResult(db: Database, runId: string, fileResult: FileResult) {
  writeSqliteFileResults(db, runId, [fileResult])
}

function writeSqliteFileResults(db: Database, runId: string, fileResults: FileResult[]) {
  const write = db.transaction((results: FileResult[]) => {
    for (const result of results) {
      deleteRunFile(db, runId, result.file.path)
      insertFile(db, runId, result.file, false)
      insertChunks(db, runId, Object.values(result.chunks))
      for (const symbol of Object.values(result.symbols)) {
        insertSymbol(db, runId, symbol)
      }
    }
  })
  write(fileResults)
}

function activateSqliteRun(db: Database, runId: string, index: CastIndex) {
  const activate = db.transaction((castIndex: CastIndex) => {
    validateCompletedRunRows(db, runId, castIndex)
    updateRunChunkLexicalStats(db, runId, castIndex.chunks)
    for (const file of Object.values(castIndex.files)) {
      upsertGlobalFile(db, file)
    }
    db.run("delete from lexical where run_id = ?", [runId])
    if (castIndex.lexical) {
      insertLexical(db, runId, castIndex.lexical)
    }
    db.run("update runs set status = 'ready', completed_at = ?, metadata_json = ? where id = ?", [
      castIndex.metadata.updatedAt,
      JSON.stringify(castIndex.metadata),
      runId,
    ])
    db.run("insert or replace into meta (key, value) values ('active_run_id', ?)", [runId])
    pruneSupersededRuns(db, runId)
  })
  activate(index)
}

function updateRunChunkLexicalStats(db: Database, runId: string, chunks: CastIndex["chunks"]) {
  const select = db.query("select record_json as recordJson from chunks where run_id = ? and id = ?")
  const update = db.query("update chunks set record_json = ? where run_id = ? and id = ?")
  for (const chunk of Object.values(chunks)) {
    if (!chunk.lexical) {
      continue
    }
    const row = select.get(runId, chunk.id) as {
      recordJson: string
    } | null
    if (!row) {
      continue
    }
    update.run(
      JSON.stringify({ ...parsePersistedJson<StoredChunkRecord>(row.recordJson), lexical: chunk.lexical }),
      runId,
      chunk.id,
    )
  }
}

function validateCompletedRunRows(db: Database, runId: string, index: CastIndex) {
  const run = db.query("select status from runs where id = ?").get(runId) as { status: string } | null
  const expected = Object.keys(index.files).sort()
  const rows = db.query("select path from file_runs where run_id = ? order by path").all(runId) as Array<{
    path: string
  }>
  const actual = rows.map((row) => row.path)
  if (run?.status !== "indexing" || !sameStringArray(actual, expected)) {
    throw new Error("incomplete indexing run cannot be activated")
  }
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function searchSqliteVectorCandidates(db: Database, queryEmbedding: number[], topK: number, paths?: string[]) {
  const pathFilters = compilePathFilters(paths)
  const search = sqliteVectorSearchInput(db, queryEmbedding, topK, pathFilters)
  if (!search) {
    return []
  }

  const limits = sqliteVectorLimits(search.vectorCount, search.target, search.hasPathFilters)
  let currentK = limits.initial
  const candidates: Array<{ id: string; score: number }> = []
  const seen = new Set<string>()
  let incomplete = false

  while (true) {
    const rows = safeQuerySqliteVectorCandidates({
      db,
      runId: search.activeRunId,
      queryEmbedding,
      topK: currentK,
      pathFilter: search.pathFilter,
    })
    appendMatchingSqliteVectorCandidates(candidates, seen, rows, pathFilters)

    if (candidates.length >= search.target || currentK >= limits.max) {
      incomplete =
        search.hasPathFilters &&
        candidates.length < search.target &&
        rows.length >= currentK &&
        currentK < search.vectorCount
      break
    }
    currentK = Math.min(limits.max, currentK * 2)
  }

  return vectorCandidateSearchResult(
    candidates.sort((left, right) => bScoreThenId(left, right)).slice(0, search.target),
    {
      incomplete,
    },
  )
}

function vectorCandidateSearchResult(
  candidates: RankedChunkCandidate[],
  metadata: { incomplete: boolean },
): VectorCandidateSearchResult {
  return Object.assign(candidates, metadata.incomplete ? { incomplete: true } : {})
}

function sqliteVectorSearchInput(
  db: Database,
  queryEmbedding: number[],
  topK: number,
  pathFilters: CompiledPathFilters,
) {
  const activeRunId = readActiveRunId(db)
  const target = Math.max(0, Math.floor(topK))
  if (!activeRunId) {
    return null
  }
  if (!canSearchSqliteVectors(db, queryEmbedding, target)) {
    return null
  }
  if (!embeddingDimensionsMatch(db, activeRunId, queryEmbedding)) {
    return null
  }
  const vectorCount = readActiveVectorCount(db, activeRunId)
  return vectorCount > 0
    ? {
        activeRunId,
        target,
        vectorCount,
        hasPathFilters: pathFilters.prefixes.length > 0 || pathFilters.hasGlob,
        pathFilter: sqlPrefixPathFilter(pathFilters),
      }
    : null
}

function canSearchSqliteVectors(db: Database, queryEmbedding: number[], target: number) {
  return (
    target > 0 && queryEmbedding.length > 0 && isValidQueryEmbedding(queryEmbedding) && tableExists(db, "chunk_vectors")
  )
}

function embeddingDimensionsMatch(db: Database, runId: string, queryEmbedding: number[]) {
  const dimensions = readRunMetadata(db, runId)?.embeddingDimensions
  return dimensions === undefined || queryEmbedding.length === dimensions
}

function safeQuerySqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlPrefixPathFilter>
}) {
  try {
    return querySqliteVectorCandidates(input)
  } catch (error) {
    if (isSqliteVecQueryEmbeddingError(error)) {
      return []
    }
    throw error
  }
}

function searchSqliteLexicalCandidates(
  db: Database,
  query: string,
  topK: number,
  paths?: string[],
): LexicalChunkCandidate[] {
  const activeRunId = readActiveRunId(db)
  const target = Math.max(0, Math.floor(topK))
  if (!activeRunId || target <= 0 || query.trim().length === 0 || !tableExists(db, "chunk_fts")) {
    return []
  }

  const pathFilters = compilePathFilters(paths)
  const pathFilter = sqlPrefixPathFilter(pathFilters)
  const queryLimit = lexicalCandidateLimit(target, paths)
  try {
    return lexicalRowsToCandidates(
      querySqliteLexicalRows({ db, query, activeRunId, pathFilter, queryLimit }),
      target,
      pathFilters,
    )
  } catch (error) {
    if (isFtsQuerySyntaxError(error)) {
      return searchTokenizedSqliteLexicalCandidates({
        db,
        query,
        activeRunId,
        pathFilter,
        queryLimit,
        target,
        pathFilters,
      })
    }
    throw error
  }
}

function querySqliteLexicalRows(input: {
  db: Database
  query: string
  activeRunId: string
  pathFilter: ReturnType<typeof sqlPrefixPathFilter>
  queryLimit: number
}) {
  return input.db
    .query(
      `select chunk_fts.id as id, chunks.file_path as filePath, chunk_fts.rank as rank
       from chunk_fts
       inner join chunks on chunks.run_id = chunk_fts.run_id and chunks.id = chunk_fts.id
       where chunk_fts match ? and chunk_fts.run_id = ?${input.pathFilter.sql}
       order by rank
       limit ?`,
    )
    .all(input.query, input.activeRunId, ...input.pathFilter.args, input.queryLimit) as Array<{
    id: string
    filePath: string
    rank: number
  }>
}

function searchTokenizedSqliteLexicalCandidates(input: {
  db: Database
  query: string
  activeRunId: string
  pathFilter: ReturnType<typeof sqlPrefixPathFilter>
  queryLimit: number
  target: number
  pathFilters: CompiledPathFilters
}) {
  const fallbackQuery = tokenizedFtsQuery(input.query)
  if (!fallbackQuery) {
    return []
  }
  try {
    return lexicalRowsToCandidates(
      querySqliteLexicalRows({ ...input, query: fallbackQuery }),
      input.target,
      input.pathFilters,
    )
  } catch (error) {
    if (isFtsQuerySyntaxError(error)) {
      return []
    }
    throw error
  }
}

function lexicalRowsToCandidates(
  rows: Array<{ id: string; filePath: string; rank: number }>,
  target: number,
  pathFilters: CompiledPathFilters,
) {
  return rows
    .filter((row) => pathFilters.matches(row.filePath))
    .map((row) => ({ id: row.id, score: row.rank * -1, bm25Score: row.rank * -1 }))
    .slice(0, target)
}

function tokenizedFtsQuery(query: string) {
  const terms = [...new Set(tokenizeCodeText(query))]
    .filter((term) => term.length > 0)
    .slice(0, SQLITE_LEXICAL_FALLBACK_QUERY_TERMS)
  return terms.length === 0 ? undefined : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
}

function isFtsQuerySyntaxError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error.message.includes("fts5: syntax error") ||
    error.message.includes("malformed MATCH expression") ||
    error.message.includes("unterminated string") ||
    error.message.startsWith("unknown special query: ") ||
    error.message.startsWith("no such column: ")
  )
}

function lexicalCandidateLimit(topK: number, paths?: string[]) {
  if (!paths || paths.length === 0) {
    return topK
  }
  return Math.max(topK, Math.min(SQLITE_LEXICAL_PATH_FILTER_MAX_K, topK * SQLITE_LEXICAL_PATH_FILTER_MULTIPLIER))
}

function sqlPrefixPathFilter(pathFilters: CompiledPathFilters) {
  const prefixes = sqlPathPrefixes(pathFilters)
  if (prefixes.length === 0) {
    return { sql: "", args: [] as string[] }
  }

  const clauses: string[] = []
  const args: string[] = []
  for (const filter of prefixes) {
    const prefix = filter.endsWith("/") ? filter : `${filter}/`
    clauses.push("(chunks.file_path = ? or chunks.file_path like ? escape '\\')")
    args.push(filter, `${escapeSqlLike(prefix)}%`)
  }

  return { sql: ` and (${clauses.join(" or ")})`, args }
}

function sqlPathPrefixes(pathFilters: CompiledPathFilters) {
  return [...new Set(pathFilters.sqlPrefixes.filter((prefix) => prefix.length > 0))]
}

function escapeSqlLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

function isValidQueryEmbedding(queryEmbedding: number[]) {
  for (let index = 0; index < queryEmbedding.length; index += 1) {
    if (!Object.hasOwn(queryEmbedding, index)) {
      return false
    }
    if (typeof queryEmbedding[index] !== "number" || !Number.isFinite(queryEmbedding[index])) {
      return false
    }
  }
  return true
}

function isSqliteVecQueryEmbeddingError(error: unknown) {
  return error instanceof Error && error.message.includes("Dimension mismatch for query vector")
}

function appendMatchingSqliteVectorCandidates(
  candidates: Array<{ id: string; score: number }>,
  seen: Set<string>,
  rows: SqliteVectorCandidateRow[],
  pathFilters: CompiledPathFilters,
) {
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue
    }
    seen.add(row.id)
    if (pathFilters.matches(row.filePath)) {
      candidates.push({
        id: row.id,
        score: cosineSimilarity(row.queryEmbedding, parsePersistedJson<number[]>(row.embedding)),
      })
    }
  }
}

function sqliteVectorLimits(vectorCount: number, topK: number, hasPathFilters: boolean) {
  const boundedVectorCount = Math.min(vectorCount, SQLITE_VECTOR_MAX_K)
  const max = hasPathFilters
    ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_MAX_K))
    : Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K))
  const initial = hasPathFilters
    ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K))
    : max
  return { initial, max }
}

function readActiveVectorCount(db: Database, runId: string) {
  const row = db
    .query(
      `select count(*) as count
       from chunk_rowids
       where run_id = ?`,
    )
    .get(runId) as { count: number }
  return row.count
}

interface SqliteVectorCandidateRow {
  rowid: number
  id: string
  filePath: string
  embedding: string
  queryEmbedding: number[]
}

function querySqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlPrefixPathFilter>
}) {
  if (input.pathFilter.sql) {
    return queryPathFilteredSqliteVectorCandidates(input)
  }
  const vectorRows = input.db
    .query(
      `select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (select rowid from chunk_rowids where run_id = ?) and embedding match ? and k = ?
       order by distance`,
    )
    .all(input.runId, JSON.stringify(input.queryEmbedding), input.topK) as Array<{ rowid: number; embedding: string }>
  const rowMetadata = readSqliteVectorRowMetadata(
    input.db,
    input.runId,
    vectorRows.map((row) => row.rowid),
  )
  return vectorRows.flatMap((row) => {
    const metadata = rowMetadata.get(row.rowid)
    return metadata ? [{ ...row, ...metadata, queryEmbedding: input.queryEmbedding }] : []
  })
}

function queryPathFilteredSqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlPrefixPathFilter>
}) {
  const vectorRows = input.db
    .query(
      `select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (
         select chunk_rowids.rowid
         from chunk_rowids
         inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
          where chunk_rowids.run_id = ?${input.pathFilter.sql}
       ) and embedding match ? and k = ?
       order by distance`,
    )
    .all(input.runId, ...input.pathFilter.args, JSON.stringify(input.queryEmbedding), input.topK) as Array<{
    rowid: number
    embedding: string
  }>
  const rowMetadata = readSqliteVectorRowMetadata(
    input.db,
    input.runId,
    vectorRows.map((row) => row.rowid),
  )
  return vectorRows.flatMap((row) => {
    const metadata = rowMetadata.get(row.rowid)
    return metadata ? [{ ...row, ...metadata, queryEmbedding: input.queryEmbedding }] : []
  })
}

function readSqliteVectorRowMetadata(db: Database, runId: string, rowids: number[]) {
  if (rowids.length === 0) {
    return new Map<number, { id: string; filePath: string }>()
  }
  const placeholders = rowids.map(() => "?").join(", ")
  const rows = db
    .query(
      `select chunk_rowids.rowid as rowid,
              chunk_rowids.chunk_id as id,
              chunks.file_path as filePath
       from chunk_rowids
       inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
       where chunk_rowids.run_id = ? and chunk_rowids.rowid in (${placeholders})`,
    )
    .all(runId, ...rowids) as Array<{ rowid: number; id: string; filePath: string }>
  return new Map(rows.map((row) => [row.rowid, { id: row.id, filePath: row.filePath }]))
}

function bScoreThenId(left: { id: string; score: number }, right: { id: string; score: number }) {
  return right.score - left.score || left.id.localeCompare(right.id)
}

function clearSqliteIndex(db: Database) {
  if (tableExists(db, "chunk_vectors")) {
    db.run("delete from chunk_vectors")
  }
  if (tableExists(db, "chunk_fts")) {
    db.run("delete from chunk_fts")
  }
  db.run("delete from chunk_rowids")
  db.run("delete from lexical")
  db.run("delete from symbols")
  db.run("delete from chunks")
  db.run("delete from file_runs")
  db.run("delete from files")
  db.run("delete from runs")
}

function insertRun(db: Database, runId: string, index: CastIndex) {
  db.run(
    "insert into runs (id, status, config_hash, started_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?)",
    [
      runId,
      index.metadata.status,
      JSON.stringify({
        embeddingModel: index.metadata.embeddingModel,
        embeddingDimensions: index.metadata.embeddingDimensions,
        maxChunkNonWhitespaceChars: index.metadata.maxChunkNonWhitespaceChars,
        chunking: index.metadata.chunking,
      }),
      index.metadata.updatedAt,
      index.metadata.updatedAt,
      JSON.stringify(index.metadata),
    ],
  )
}

function insertFile(db: Database, runId: string, file: FileRecord, updateGlobalFile = true) {
  if (updateGlobalFile) {
    upsertGlobalFile(db, file)
  }
  db.run(
    "insert or replace into file_runs (run_id, path, language, fingerprint, size_bytes, mtime_ms, ctime_ms, diagnostics_json, chunk_ids_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      runId,
      file.path,
      file.language,
      file.fingerprint,
      file.sizeBytes ?? null,
      file.mtimeMs ?? null,
      file.ctimeMs ?? null,
      JSON.stringify(file.diagnostics),
      JSON.stringify(file.chunkIds),
    ],
  )
}

function upsertGlobalFile(db: Database, file: FileRecord) {
  db.run(
    "insert or replace into files (path, language, fingerprint, size_bytes, mtime_ms, ctime_ms, diagnostics_json) values (?, ?, ?, ?, ?, ?, ?)",
    [
      file.path,
      file.language,
      file.fingerprint,
      file.sizeBytes ?? null,
      file.mtimeMs ?? null,
      file.ctimeMs ?? null,
      JSON.stringify(file.diagnostics),
    ],
  )
}

function insertChunks(db: Database, runId: string, chunks: ChunkRecord[]) {
  insertChunksWithVectorRowids(db, runId, chunks, nextVectorRowid(db))
}

function insertChunksWithVectorRowids(db: Database, runId: string, chunks: ChunkRecord[], initialVectorRowid: number) {
  let vectorRowid = initialVectorRowid
  for (const chunk of chunks) {
    db.run("insert into chunks (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
      runId,
      chunk.id,
      chunk.filePath,
      chunk.kind,
      JSON.stringify(chunkForStorage(chunk)),
    ])
    if (chunk.embedding) {
      db.run("insert into chunk_vectors (rowid, embedding) values (?, ?)", [
        vectorRowid,
        JSON.stringify(chunk.embedding),
      ])
      db.run("insert into chunk_rowids (run_id, chunk_id, rowid) values (?, ?, ?)", [runId, chunk.id, vectorRowid])
      vectorRowid += 1
    }
    db.run("insert into chunk_fts (run_id, id, content) values (?, ?, ?)", [runId, chunk.id, chunk.text])
  }
}

function nextVectorRowid(db: Database) {
  const row = db.query("select coalesce(max(rowid), 0) + 1 as rowid from chunk_rowids").get() as { rowid: number }
  return row.rowid
}

function deleteRunFile(db: Database, runId: string, filePath: string) {
  const rows = db
    .query(
      "select chunk_rowids.rowid from chunk_rowids inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id where chunks.run_id = ? and chunks.file_path = ?",
    )
    .all(runId, filePath) as Array<{ rowid: number }>
  if (tableExists(db, "chunk_vectors")) {
    for (const row of rows) {
      db.run("delete from chunk_vectors where rowid = ?", [row.rowid])
    }
  }
  db.run(
    "delete from chunk_rowids where run_id = ? and chunk_id in (select id from chunks where run_id = ? and file_path = ?)",
    [runId, runId, filePath],
  )
  db.run(
    "delete from chunk_fts where run_id = ? and id in (select id from chunks where run_id = ? and file_path = ?)",
    [runId, runId, filePath],
  )
  db.run("delete from chunks where run_id = ? and file_path = ?", [runId, filePath])
  db.run("delete from symbols where run_id = ? and file_path = ?", [runId, filePath])
  db.run("delete from file_runs where run_id = ? and path = ?", [runId, filePath])
}

function deleteRunRecords(db: Database, runId: string) {
  const rows = db.query("select rowid from chunk_rowids where run_id = ?").all(runId) as Array<{ rowid: number }>
  if (tableExists(db, "chunk_vectors")) {
    for (const row of rows) {
      db.run("delete from chunk_vectors where rowid = ?", [row.rowid])
    }
  }
  db.run("delete from chunk_rowids where run_id = ?", [runId])
  db.run("delete from chunk_fts where run_id = ?", [runId])
  db.run("delete from lexical where run_id = ?", [runId])
  db.run("delete from symbols where run_id = ?", [runId])
  db.run("delete from chunks where run_id = ?", [runId])
  db.run("delete from file_runs where run_id = ?", [runId])
}

function pruneSupersededRuns(db: Database, activeRunId: string) {
  const runs = db.query("select id from runs where id != ?").all(activeRunId) as Array<{ id: string }>
  for (const run of runs) {
    deleteRunRecords(db, run.id)
    db.run("delete from runs where id = ?", [run.id])
  }
  db.run("delete from files where path not in (select path from file_runs where run_id = ?)", [activeRunId])
}

function insertSymbol(db: Database, runId: string, symbol: SymbolRecord) {
  db.run("insert into symbols (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
    runId,
    symbol.id,
    symbol.filePath,
    symbol.kind,
    JSON.stringify(symbol),
  ])
}

function insertLexical(db: Database, runId: string, lexical: LexicalIndex) {
  db.run("insert into lexical (run_id, metadata_json) values (?, ?)", [runId, JSON.stringify(lexical)])
}

function initializeSchema(db: Database, embeddingDimensions?: number) {
  db.run("create table if not exists meta (key text primary key, value text not null)")
  db.run("insert or replace into meta (key, value) values ('schema_version', ?)", [String(SQLITE_SCHEMA_VERSION)])
  db.run(
    "create table if not exists runs (id text primary key, status text not null, config_hash text not null, started_at integer not null, completed_at integer, metadata_json text not null)",
  )
  db.run(
    "create table if not exists files (path text primary key, language text not null, fingerprint text not null, diagnostics_json text not null)",
  )
  addColumnIfMissing(db, "files", "size_bytes", "integer")
  addColumnIfMissing(db, "files", "mtime_ms", "real")
  addColumnIfMissing(db, "files", "ctime_ms", "real")
  db.run(
    "create table if not exists file_runs (run_id text not null, path text not null, chunk_ids_json text not null, primary key (run_id, path))",
  )
  addColumnIfMissing(db, "file_runs", "language", "text")
  addColumnIfMissing(db, "file_runs", "fingerprint", "text")
  addColumnIfMissing(db, "file_runs", "size_bytes", "integer")
  addColumnIfMissing(db, "file_runs", "mtime_ms", "real")
  addColumnIfMissing(db, "file_runs", "ctime_ms", "real")
  addColumnIfMissing(db, "file_runs", "diagnostics_json", "text")
  db.run(
    "create table if not exists chunks (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))",
  )
  db.run("create index if not exists chunks_run_file_path_idx on chunks (run_id, file_path)")
  db.run(
    "create table if not exists symbols (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))",
  )
  db.run("create index if not exists symbols_run_file_path_idx on symbols (run_id, file_path)")
  db.run("create table if not exists lexical (run_id text primary key, metadata_json text not null)")
  db.run(
    "create table if not exists chunk_rowids (run_id text not null, chunk_id text not null, rowid integer not null, primary key (run_id, chunk_id))",
  )
  db.run("create index if not exists chunk_rowids_run_rowid_idx on chunk_rowids (run_id, rowid)")
  if (embeddingDimensions !== undefined) {
    db.run(`create virtual table if not exists chunk_vectors using vec0(embedding float[${embeddingDimensions}])`)
  }
  db.run("create virtual table if not exists chunk_fts using fts5(run_id unindexed, id unindexed, content)")
}

function tableExists(db: Database, table: string) {
  return Boolean(db.query("select name from sqlite_master where type = 'table' and name = ?").get(table))
}

function inferEmbeddingDimensions(index: CastIndex) {
  return (
    index.metadata.embeddingDimensions ??
    Object.values(index.chunks).find((chunk) => chunk.embedding)?.embedding?.length
  )
}

function inferFileResultEmbeddingDimensions(fileResult: FileResult) {
  return Object.values(fileResult.chunks).find((chunk) => chunk.embedding)?.embedding?.length
}

function inferFileResultsEmbeddingDimensions(fileResults: FileResult[]) {
  return fileResults.map(inferFileResultEmbeddingDimensions).find((dimensions) => dimensions !== undefined)
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string) {
  const columns = db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((existing) => existing.name === column)) {
    db.run(`alter table ${table} add column ${column} ${definition}`)
  }
}

export function cosineSimilarity(left: number[], right: number[]) {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0))
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0))
  return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0
}

export function searchVectors(query: number[], vectors: Array<{ id: string; vector: number[] }>, topK: number) {
  return vectors
    .map((vector) => ({ id: vector.id, score: cosineSimilarity(query, vector.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK))
}

function isCastIndex(value: unknown): value is CastIndex {
  return (
    isObject(value) &&
    isIndexMetadata(value.metadata) &&
    isRecordMap(value.files, isFileRecord) &&
    isRecordMap(value.chunks, isChunkRecord) &&
    isRecordMap(value.symbols, isSymbolRecord) &&
    (value.lexical === undefined || isLexicalIndex(value.lexical))
  )
}

function isIndexMetadata(value: unknown) {
  if (!isObject(value)) {
    return false
  }
  return allPass([
    value.schemaVersion === INDEX_SCHEMA_VERSION,
    typeof value.projectId === "string",
    typeof value.worktree === "string",
    typeof value.cacheKey === "string",
    typeof value.maxChunkNonWhitespaceChars === "number",
    isChunkingOptions(value.chunking),
    typeof value.updatedAt === "number",
    INDEX_STATUSES.includes(value.status),
    isStringArray(value.diagnostics),
    isOptionalString(value.embeddingModel),
    isOptionalNumber(value.embeddingDimensions),
  ])
}

function isChunkingOptions(value: unknown): value is ChunkingOptions {
  return (
    isObject(value) &&
    isNonnegativeNumber(value.overlap) &&
    Number.isInteger(value.overlap) &&
    typeof value.expansion === "boolean" &&
    typeof value.minSemanticNonWhitespaceChars === "number" &&
    Number.isInteger(value.minSemanticNonWhitespaceChars) &&
    value.minSemanticNonWhitespaceChars > 0
  )
}

function isFileRecord(value: unknown) {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    typeof value.language === "string" &&
    typeof value.fingerprint === "string" &&
    isOptionalNonnegativeNumber(value.sizeBytes) &&
    isOptionalNonnegativeNumber(value.mtimeMs) &&
    isOptionalNonnegativeNumber(value.ctimeMs) &&
    isStringArray(value.chunkIds) &&
    isStringArray(value.diagnostics)
  )
}

function isChunkRecord(value: unknown) {
  if (!isObject(value)) {
    return false
  }
  return allPass([
    typeof value.id === "string",
    typeof value.filePath === "string",
    typeof value.language === "string",
    CHUNK_KINDS.includes(value.kind),
    isSourceRange(value.range),
    typeof value.text === "string",
    typeof value.nonWhitespaceChars === "number",
    isStringArray(value.nodeTypes),
    isStringArray(value.symbolIds),
    isStringArray(value.childChunkIds),
    isOptionalString(value.parentChunkId),
    isOptionalString(value.previousSiblingChunkId),
    isOptionalString(value.nextSiblingChunkId),
    isOptionalNumberArray(value.embedding),
    isOptionalString(value.embeddingError),
    value.lexical === undefined || isChunkLexicalStats(value.lexical),
  ])
}

function isLexicalIndex(value: unknown) {
  return (
    isObject(value) &&
    isNonnegativeNumber(value.documentCount) &&
    isNonnegativeNumber(value.averageDocumentLength) &&
    isRecordMap(value.documentFrequencies, isNonnegativeNumber)
  )
}

function isChunkLexicalStats(value: unknown) {
  return isObject(value) && isNonnegativeNumber(value.length) && isRecordMap(value.termFrequencies, isNonnegativeNumber)
}

function isSymbolRecord(value: unknown) {
  if (!isObject(value)) {
    return false
  }
  return allPass([
    typeof value.id === "string",
    typeof value.name === "string",
    SYMBOL_KINDS.includes(value.kind),
    typeof value.filePath === "string",
    isSourceRange(value.range),
    isOptionalString(value.parentSymbolId),
    isStringArray(value.childSymbolIds),
  ])
}

function isSourceRange(value: unknown) {
  return (
    isObject(value) &&
    typeof value.byteStart === "number" &&
    typeof value.byteEnd === "number" &&
    typeof value.lineStart === "number" &&
    typeof value.lineEnd === "number"
  )
}

function isRecordMap(value: unknown, isValue: (value: unknown) => boolean) {
  return isObject(value) && Object.values(value).every(isValue)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isNumberArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
}

function isOptionalNumberArray(value: unknown) {
  return value === undefined || isNumberArray(value)
}

function isNonnegativeNumber(value: unknown) {
  return typeof value === "number" && value >= 0
}

function isOptionalNonnegativeNumber(value: unknown) {
  return value === undefined || isNonnegativeNumber(value)
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isOptionalNumber(value: unknown) {
  return value === undefined || typeof value === "number"
}

function allPass(checks: boolean[]) {
  return checks.every(Boolean)
}
