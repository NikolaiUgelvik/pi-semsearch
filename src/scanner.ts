import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { Minimatch } from "minimatch"
import { castChunks, type SyntaxNode } from "./cast.js"
import { fallbackChunks } from "./fallback.js"
import { buildLexicalIndex } from "./lexical.js"
import { createSourceIndex, type SourceIndex } from "./range.js"
import { assignSymbolsToChunks, attachTopology, extractSymbols } from "./topology.js"
import type { CastIndex, ChunkingOptions, ChunkRecord, DiagnosticRecord, FileRecord, SymbolRecord } from "./types.js"

export type FileResult = {
  file: FileRecord
  chunks: Record<string, ChunkRecord>
  symbols: Record<string, SymbolRecord>
}
export type Store = {
  read(): Promise<CastIndex>
  write(index: CastIndex): Promise<void>
  beginIndexRun?(input: { configHash: string; metadata: CastIndex["metadata"] }): Promise<{ runId: string }>
  getCompletedFile?(runId: string, filePath: string, fingerprint: string): Promise<FileResult | undefined>
  writeFileResult?(runId: string, fileResult: FileResult): Promise<void>
  writeFileResults?(runId: string, fileResults: FileResult[]): Promise<void>
  activateRun?(runId: string, index: CastIndex): Promise<void>
}
type GitignoreMatcher = { base: string; matcher: Ignore }
type CreateIndexerInput = Parameters<typeof createIndexer>[0]
type IndexRunStore = Store &
  Required<Pick<Store, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">>
type SymbolsByFilePath = Map<string, SymbolRecord[]>
type RefreshState = {
  nextFiles: CastIndex["files"]
  nextChunks: CastIndex["chunks"]
  nextSymbols: CastIndex["symbols"]
  symbolsByFilePath: SymbolsByFilePath
  metadataDiagnostics: string[]
  metadataDiagnosticDetails: DiagnosticRecord[]
  reusedFileResults: FileResult[]
  canReuseExistingRecords: boolean
  reusedRecordsChanged: boolean
  changed: boolean
}
type LoadedFile = {
  fingerprint: string
  text: string
}
type FileStatMetadata = {
  sizeBytes: number
  mtimeMs: number
  ctimeMs: number
}
type EmbeddingResult = { embedding: number[] } | { embeddingError: string }
type EmbeddingBatcher = {
  embed(text: string): Promise<EmbeddingResult>
  drain(): Promise<void>
}
type FileResultWriter = {
  add(fileResult: FileResult): Promise<void>
  flush(): Promise<void>
}
type ScanPredicates = {
  includes(filePath: string): boolean
  excludes(filePath: string): boolean
  excludesDirectory(relativePath: string): boolean
}
type WalkDirectory = { prefix: string; gitignores: GitignoreMatcher[] }
const BINARY_SAMPLE_BYTES = Number("16") * Number("1024")
const BYTE_NUL = 0
const BYTE_BACKSPACE = 8
const BYTE_TAB = 9
const BYTE_LINE_FEED = 10
const BYTE_FORM_FEED = 12
const BYTE_CARRIAGE_RETURN = 13
const CONTROL_BYTE_LIMIT = 32
const BINARY_CONTROL_RATIO = 0.3
const DEFAULT_EMBEDDING_BATCH_SIZE = 16
const DEFAULT_EMBEDDING_BATCH_CONCURRENCY = 1
const DEFAULT_FILE_CONCURRENCY = 4
const DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE = 32
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".cache"])
const MAX_QUEUED_REUSED_FILE_RESULTS = 256
const STAT_FAST_PATH_SETTLE_MS = 1000
const TRAILING_SLASHES = /\/+$/

export function createIndexer(input: {
  worktree: string
  options: {
    maxChunkNonWhitespaceChars: number
    maxFileBytes: number
    includeGlobs: string[]
    excludeGlobs: string[]
    topK: number
    maxContextChars: number
    chunking: ChunkingOptions
    embeddingBatchSize?: number
    embeddingBatchConcurrency?: number
  }
  store: Store
  parse(filePath: string, source: string): Promise<{ language: string; root?: SyntaxNode }>
  embed(text: string, signal?: AbortSignal): Promise<number[]>
  embedBatch?(texts: string[], signal?: AbortSignal): Promise<number[][]>
}) {
  return {
    async refresh(signal?: AbortSignal) {
      signal?.throwIfAborted()
      const store = input.store
      const index = await store.read()
      signal?.throwIfAborted()
      const runStore = hasRunStore(store) ? store : undefined
      const state = createRefreshState(index, input)
      const runController = createIndexRunController(index, input, runStore)
      const embeddingBatcher = createEmbeddingBatcher(input, signal)
      const fileResultWriter = createFileResultWriter({ runStore, run: runController.run })

      const changed = await processScannedFiles({
        files: scanFiles(input.worktree, input.options.includeGlobs, input.options.excludeGlobs),
        input,
        index,
        state,
        runStore,
        run: runController.run,
        ensureRun: runController.ensureRun,
        embeddingBatcher,
        fileResultWriter,
        signal,
      })

      signal?.throwIfAborted()
      await embeddingBatcher.drain()
      signal?.throwIfAborted()
      await fileResultWriter.flush()
      state.metadataDiagnostics.sort()
      const lexicalIndex = buildLexicalIndex(state.nextChunks, state.nextSymbols)
      const hasFileSetChange = !sameStringArray(Object.keys(index.files).sort(), Object.keys(state.nextFiles).sort())
      const hasDiagnosticsChange = !sameStringArray(index.metadata.diagnostics, state.metadataDiagnostics)
      const hasDiagnosticDetailsChange =
        stableStringify(index.metadata.diagnosticDetails ?? []) !== stableStringify(state.metadataDiagnosticDetails)
      const hasScannerOptionsChange = !sameScannerOptions(index.metadata, input.options)
      if (
        canSkipRefresh(
          index,
          input.worktree,
          changed || state.reusedRecordsChanged,
          state.canReuseExistingRecords,
          hasFileSetChange,
          hasDiagnosticsChange || hasDiagnosticDetailsChange || hasScannerOptionsChange,
        )
      ) {
        return index
      }
      await flushQueuedReusedFileResults({
        state,
        runStore,
        run: runController.run,
        ensureRun: runController.ensureRun,
        fileResultWriter,
      })
      await fileResultWriter.flush()

      signal?.throwIfAborted()
      index.files = state.nextFiles
      index.chunks = lexicalIndex.chunks
      index.symbols = state.nextSymbols
      index.lexical = lexicalIndex.lexical
      index.metadata.worktree = input.worktree
      index.metadata.maxFileBytes = input.options.maxFileBytes
      index.metadata.includeGlobs = input.options.includeGlobs
      index.metadata.excludeGlobs = input.options.excludeGlobs
      index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars
      index.metadata.chunking = input.options.chunking
      index.metadata.diagnostics = state.metadataDiagnostics
      index.metadata.diagnosticDetails = state.metadataDiagnosticDetails
      index.metadata.status = "ready"
      index.metadata.updatedAt = Date.now()
      await persistRefreshedIndex({
        index,
        store,
        runStore,
        run: runController.run,
        ensureRun: runController.ensureRun,
      })
      return index
    },
  }
}

function createRefreshState(index: CastIndex, input: CreateIndexerInput): RefreshState {
  return {
    nextFiles: {},
    nextChunks: {},
    nextSymbols: {},
    symbolsByFilePath: symbolsByFilePath(index.symbols),
    metadataDiagnostics: [],
    metadataDiagnosticDetails: [],
    reusedFileResults: [],
    canReuseExistingRecords: canReuseExistingIndexRecords(index, input),
    reusedRecordsChanged: false,
    changed: false,
  }
}

function canReuseExistingIndexRecords(index: CastIndex, input: CreateIndexerInput) {
  return (
    index.metadata.maxChunkNonWhitespaceChars === input.options.maxChunkNonWhitespaceChars &&
    sameChunkingOptions(index.metadata.chunking, input.options.chunking)
  )
}

function createIndexRunController(index: CastIndex, input: CreateIndexerInput, runStore: IndexRunStore | undefined) {
  let run: { runId: string } | undefined
  let runPromise: Promise<{ runId: string } | undefined> | undefined
  return {
    run: () => run,
    ensureRun: async () => {
      if (!runStore) {
        return
      }
      if (!runPromise) {
        markIndexing(index, input)
        runPromise = runStore.beginIndexRun({
          configHash: indexRunConfigHash(index, input.worktree, input.options),
          metadata: index.metadata,
        })
      }
      run = run ?? (await runPromise)
      return run
    },
  }
}

function markIndexing(index: CastIndex, input: CreateIndexerInput) {
  index.metadata.status = "indexing"
  applyScannerMetadata(index, input)
}

function applyScannerMetadata(index: CastIndex, input: CreateIndexerInput) {
  index.metadata.worktree = input.worktree
  index.metadata.maxFileBytes = input.options.maxFileBytes
  index.metadata.includeGlobs = input.options.includeGlobs
  index.metadata.excludeGlobs = input.options.excludeGlobs
  index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars
  index.metadata.chunking = input.options.chunking
}

async function processScannedFiles(input: {
  files: AsyncIterable<string>
  input: CreateIndexerInput
  index: CastIndex
  state: RefreshState
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  embeddingBatcher: EmbeddingBatcher
  fileResultWriter: FileResultWriter
  signal?: AbortSignal
}) {
  const inFlight = new Set<Promise<void>>()
  let failed = false
  let firstError: unknown

  const recordFailure = (error: unknown) => {
    if (!failed) {
      failed = true
      firstError = error
    }
  }

  const waitForCapacity = async () => {
    while (!failed && inFlight.size >= DEFAULT_FILE_CONCURRENCY) {
      await Promise.race(inFlight)
    }
  }

  try {
    for await (const relativePath of input.files) {
      input.signal?.throwIfAborted()
      await waitForCapacity()
      input.signal?.throwIfAborted()
      if (failed) {
        break
      }
      const worker = processScannedFile({ ...input, relativePath })
        .then((nextChanged) => {
          input.state.changed = input.state.changed || nextChanged
        })
        .catch(recordFailure)
        .finally(() => {
          inFlight.delete(worker)
        })
      inFlight.add(worker)
    }
    await Promise.allSettled(inFlight)
    if (failed) {
      throw firstError
    }
    return input.state.changed
  } catch (error) {
    await Promise.allSettled(inFlight)
    await flushFileResultsAfterWorkerFailure(input.fileResultWriter, error)
    throw error
  }
}

async function flushFileResultsAfterWorkerFailure(fileResultWriter: FileResultWriter, error: unknown) {
  try {
    await fileResultWriter.flush()
  } catch (flushError) {
    if (flushError === error) {
      throw error
    }
    throw new AggregateError([error, flushError], "refresh failed and flushing file results failed")
  }
}

function canSkipRefresh(
  index: CastIndex,
  worktree: string,
  changed: boolean,
  canReuseExistingRecords: boolean,
  hasFileSetChange: boolean,
  hasDiagnosticsChange: boolean,
) {
  return (
    index.metadata.status === "ready" &&
    !changed &&
    unchangedIndexShape(index, worktree, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange)
  )
}

function unchangedIndexShape(
  index: CastIndex,
  worktree: string,
  canReuseExistingRecords: boolean,
  hasFileSetChange: boolean,
  hasDiagnosticsChange: boolean,
) {
  return [
    !hasFileSetChange,
    !hasDiagnosticsChange,
    index.metadata.worktree === worktree,
    canReuseExistingRecords,
  ].every(Boolean)
}

function sameScannerOptions(metadata: CastIndex["metadata"], options: CreateIndexerInput["options"]) {
  return (
    metadata.maxFileBytes === options.maxFileBytes &&
    sameStringArray(metadata.includeGlobs, options.includeGlobs) &&
    sameStringArray(metadata.excludeGlobs, options.excludeGlobs)
  )
}

async function persistRefreshedIndex(input: {
  index: CastIndex
  store: Store
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
}) {
  const run = input.run() ?? (input.runStore ? await input.ensureRun() : undefined)
  if (run && input.runStore) {
    await input.runStore.activateRun(run.runId, input.index)
    return
  }
  await input.store.write(input.index)
}

type ScannedFileInput = {
  input: CreateIndexerInput
  index: CastIndex
  state: RefreshState
  relativePath: string
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  embeddingBatcher: EmbeddingBatcher
  fileResultWriter: FileResultWriter
  signal?: AbortSignal
}

async function processScannedFile(input: ScannedFileInput) {
  input.signal?.throwIfAborted()
  const absolutePath = path.join(input.input.worktree, input.relativePath)
  const fileStat = await statFileForIndexing(absolutePath)
  const previousFile = input.index.files[input.relativePath]

  if (await reuseReadableStatFile(input, absolutePath, fileStat, previousFile)) {
    return input.state.changed
  }
  if (await recordSkippedFile(input, absolutePath, fileStat)) {
    return input.state.changed
  }

  const loaded = await loadTextFileForIndexing(absolutePath)
  input.signal?.throwIfAborted()
  if (await reuseLoadedFile(input, previousFile, loaded.fingerprint)) {
    return input.state.changed
  }
  if (await reuseCompletedFileResult(input, loaded.fingerprint)) {
    return true
  }

  await indexFile({ ...input, absolutePath, currentFingerprint: loaded.fingerprint, fileStat, text: loaded.text })
  return true
}

async function reuseReadableStatFile(
  input: ScannedFileInput,
  absolutePath: string,
  fileStat: FileStatMetadata | undefined,
  previousFile: FileRecord | undefined,
) {
  if (!fileStat || fileStat.sizeBytes > input.input.options.maxFileBytes) {
    return false
  }
  const canRead = await canReadFile(absolutePath)
  if (canRead && !statIsOlderThanIndex(fileStat, input.index.metadata.updatedAt)) {
    return false
  }
  if (
    !(
      previousFile &&
      canReuseFileWithStat(
        input.index,
        input.state.symbolsByFilePath,
        previousFile,
        input.relativePath,
        fileStat,
        input.state.canReuseExistingRecords,
      )
    )
  ) {
    return false
  }
  await reuseScannedFile(input, previousFile)
  return true
}

async function recordSkippedFile(
  input: ScannedFileInput,
  absolutePath: string,
  fileStat: FileStatMetadata | undefined,
) {
  const skipDiagnostic = await skipFileDiagnostic(
    input.relativePath,
    absolutePath,
    fileStat,
    input.input.options.maxFileBytes,
  )
  if (!skipDiagnostic) {
    return false
  }
  input.state.metadataDiagnostics.push(skipDiagnostic.message)
  input.state.metadataDiagnosticDetails.push(skipDiagnostic)
  return true
}

async function reuseLoadedFile(
  input: ScannedFileInput,
  previousFile: FileRecord | undefined,
  currentFingerprint: string,
) {
  if (
    !(
      previousFile &&
      canReuseFile(
        input.index,
        input.state.symbolsByFilePath,
        previousFile,
        input.relativePath,
        currentFingerprint,
        input.state.canReuseExistingRecords,
      )
    )
  ) {
    return false
  }
  await reuseScannedFile(input, previousFile)
  return true
}

async function reuseCompletedFileResult(input: ScannedFileInput, currentFingerprint: string) {
  const activeRun = await input.ensureRun()
  await flushQueuedReusedFileResults(input)
  const completed = activeRun
    ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
    : undefined
  if (!(completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint))) {
    return false
  }
  reuseCompletedFileRecords(completed, input.state)
  return true
}

async function reuseScannedFile(
  input: {
    index: CastIndex
    state: RefreshState
    run: () => { runId: string } | undefined
    ensureRun: () => Promise<{ runId: string } | undefined>
    runStore: IndexRunStore | undefined
    fileResultWriter: FileResultWriter
  },
  previousFile: FileRecord,
) {
  const reused = reuseFileRecords(input.index, previousFile, input.state)
  if (!input.runStore) {
    return
  }
  if (input.run()) {
    await input.fileResultWriter.add(reused)
    return
  }
  input.state.reusedFileResults.push(reused)
  if (input.state.reusedFileResults.length >= MAX_QUEUED_REUSED_FILE_RESULTS) {
    await flushQueuedReusedFileResults(input)
  }
}

function reuseFileRecords(index: CastIndex, file: FileRecord, state: RefreshState): FileResult {
  state.nextFiles[file.path] = file
  const chunks: Record<string, ChunkRecord> = {}
  for (const chunkId of file.chunkIds) {
    if (index.chunks[chunkId]) {
      state.nextChunks[chunkId] = index.chunks[chunkId]
      chunks[chunkId] = index.chunks[chunkId]
    }
  }
  const symbols: Record<string, SymbolRecord> = {}
  const referencedSymbolIds = referencedSymbolsForReusedChunks(index, file.path, chunks)
  for (const symbolId of referencedSymbolIds) {
    const symbol = index.symbols[symbolId]
    if (symbol) {
      const retainedSymbol = retainedSymbolRecord(index, symbol, referencedSymbolIds)
      state.nextSymbols[retainedSymbol.id] = retainedSymbol
      symbols[retainedSymbol.id] = retainedSymbol
    }
  }
  if (reusedSymbolsChanged(state.symbolsByFilePath.get(file.path) ?? [], Object.values(symbols))) {
    state.reusedRecordsChanged = true
  }
  return { file, chunks, symbols }
}

function reusedSymbolsChanged(originalSymbols: SymbolRecord[], retainedSymbols: SymbolRecord[]) {
  return (
    stableStringify(symbolsForComparison(originalSymbols)) !== stableStringify(symbolsForComparison(retainedSymbols))
  )
}

function symbolsForComparison(symbols: SymbolRecord[]) {
  return [...symbols].sort((left, right) => left.id.localeCompare(right.id))
}

function referencedSymbolsForReusedChunks(index: CastIndex, filePath: string, chunks: Record<string, ChunkRecord>) {
  const referenced = new Set<string>()
  const queue = Object.values(chunks).flatMap((chunk) => chunk.symbolIds)
  while (queue.length > 0) {
    const symbolId = queue.shift()
    if (!symbolId) {
      continue
    }
    if (referenced.has(symbolId) || !validSymbolId(index, symbolId, filePath)) {
      continue
    }
    referenced.add(symbolId)
    const symbol = index.symbols[symbolId]
    if (symbol.parentSymbolId) {
      queue.push(symbol.parentSymbolId)
    }
  }
  return referenced
}

function retainedSymbolRecord(index: CastIndex, symbol: SymbolRecord, retainedSymbolIds: Set<string>): SymbolRecord {
  return {
    ...symbol,
    childSymbolIds: symbol.childSymbolIds.filter(
      (id) => retainedSymbolIds.has(id) && index.symbols[id]?.parentSymbolId === symbol.id,
    ),
  }
}

async function flushQueuedReusedFileResults(input: {
  state: RefreshState
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  fileResultWriter: FileResultWriter
}) {
  if (input.state.reusedFileResults.length === 0 || !input.runStore) {
    return
  }
  await input.ensureRun()
  const queued = input.state.reusedFileResults.splice(0)
  for (const fileResult of queued) {
    await input.fileResultWriter.add(fileResult)
  }
  await input.fileResultWriter.flush()
}

function completedFileResult(
  runStore: IndexRunStore | undefined,
  runId: string,
  relativePath: string,
  currentFingerprint: string,
) {
  return runStore?.getCompletedFile(runId, relativePath, currentFingerprint)
}

function canReuseCompletedFile(
  index: CastIndex,
  completed: FileResult,
  relativePath: string,
  currentFingerprint: string,
) {
  const completedIndex = {
    ...index,
    files: { [relativePath]: completed.file },
    chunks: completed.chunks,
    symbols: completed.symbols,
  }
  return canReuseFile(
    completedIndex,
    symbolsByFilePath(completed.symbols),
    completed.file,
    relativePath,
    currentFingerprint,
    true,
  )
}

function reuseCompletedFileRecords(completed: FileResult, state: RefreshState) {
  state.nextFiles[completed.file.path] = completed.file
  Object.assign(state.nextChunks, completed.chunks)
  Object.assign(state.nextSymbols, completed.symbols)
}

async function indexFile(input: {
  input: CreateIndexerInput
  state: RefreshState
  relativePath: string
  absolutePath: string
  currentFingerprint: string
  fileStat: FileStatMetadata | undefined
  text: string
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  embeddingBatcher: EmbeddingBatcher
  fileResultWriter: FileResultWriter
  signal?: AbortSignal
}) {
  const sourceIndex = createSourceIndex(input.text)
  const parsed = await input.input.parse(input.absolutePath, input.text).catch((error) => ({
    language: "text",
    root: undefined,
    diagnostic: String(error),
  }))
  input.signal?.throwIfAborted()
  const language = parsed.language
  const root = parsed.root
  const rawChunks = rawChunksForParsedFile(input, sourceIndex, language, root)
  const symbols = symbolsForParsedFile(input, sourceIndex, root)
  const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]))
  const chunks = attachTopology(assignSymbolsToChunks(rawChunks, symbolsById), symbolsById)
  const fileDiagnostics = "diagnostic" in parsed ? [String(parsed.diagnostic)] : []
  const fileChunks = await embedChunks({ ...input, parsed: { language }, chunks, symbolsById, fileDiagnostics })
  await recordIndexedFile(input, language, symbols, chunks, fileChunks, fileDiagnostics)
}

function rawChunksForParsedFile(
  input: Parameters<typeof indexFile>[0],
  sourceIndex: SourceIndex,
  language: string,
  root: SyntaxNode | undefined,
) {
  return root
    ? castChunks({
        filePath: input.relativePath,
        language,
        source: input.text,
        sourceIndex,
        root,
        maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
        chunking: input.input.options.chunking,
      })
    : fallbackChunks({
        filePath: input.relativePath,
        language,
        text: input.text,
        maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
        sourceIndex,
      })
}

function symbolsForParsedFile(
  input: Parameters<typeof indexFile>[0],
  sourceIndex: SourceIndex,
  root: SyntaxNode | undefined,
) {
  return root
    ? extractSymbols({ filePath: input.relativePath, source: input.text, sourceIndex, nodes: root.children })
    : []
}

function recordIndexedFile(
  input: Parameters<typeof indexFile>[0],
  language: string,
  symbols: SymbolRecord[],
  chunks: ChunkRecord[],
  fileChunks: Record<string, ChunkRecord>,
  fileDiagnostics: string[],
) {
  Object.assign(input.state.nextChunks, fileChunks)
  for (const symbol of symbols) {
    input.state.nextSymbols[symbol.id] = symbol
  }
  const fileRecord = indexedFileRecord(input, language, chunks, fileDiagnostics)
  input.state.nextFiles[input.relativePath] = fileRecord
  return input.fileResultWriter.add({
    file: fileRecord,
    chunks: fileChunks,
    symbols: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
  })
}

function indexedFileRecord(
  input: Parameters<typeof indexFile>[0],
  language: string,
  chunks: ChunkRecord[],
  fileDiagnostics: string[],
) {
  return {
    path: input.relativePath,
    language,
    fingerprint: input.currentFingerprint,
    sizeBytes: input.fileStat?.sizeBytes,
    mtimeMs: input.fileStat?.mtimeMs,
    ctimeMs: input.fileStat?.ctimeMs,
    chunkIds: chunks.map((chunk) => chunk.id),
    diagnostics: fileDiagnostics,
  }
}

function createFileResultWriter(input: {
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
}): FileResultWriter {
  const pending: FileResult[] = []
  let writeChain = Promise.resolve()

  const enqueue = (batch: FileResult[]) => {
    writeChain = writeChain.then(async () => {
      const run = input.run()
      const runStore = input.runStore
      if (!run) {
        return
      }
      if (!runStore) {
        return
      }
      if (hasBatchRunStore(runStore)) {
        await runStore.writeFileResults(run.runId, batch)
        return
      }
      for (const fileResult of batch) {
        await runStore.writeFileResult(run.runId, fileResult)
      }
    })
    return writeChain
  }

  const flushPending = () => {
    if (pending.length === 0) {
      return writeChain
    }
    return enqueue(pending.splice(0, pending.length))
  }

  return {
    add(fileResult) {
      const runStore = input.runStore
      if (!runStore) {
        return Promise.resolve()
      }
      const run = input.run()
      if (!run) {
        return Promise.resolve()
      }
      if (!hasBatchRunStore(runStore)) {
        return enqueue([fileResult])
      }
      pending.push(fileResult)
      return pending.length >= DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE ? flushPending() : writeChain
    },
    flush() {
      return flushPending()
    },
  }
}

function createEmbeddingBatcher(input: CreateIndexerInput, signal?: AbortSignal): EmbeddingBatcher {
  type PendingEmbedding = {
    text: string
    resolve: (result: EmbeddingResult) => void
    reject: (error: unknown) => void
  }

  const batchSize = Math.max(1, input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE)
  const maxOutstanding = Math.max(1, input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY)
  const queue: PendingEmbedding[] = []
  const outstanding = new Set<Promise<void>>()
  let scheduled = false

  const rejectQueued = () => {
    const error = signal?.reason ?? new Error("This operation was aborted")
    for (const item of queue.splice(0)) {
      item.reject(error)
    }
  }

  const flush = () => {
    scheduled = false
    if (signal?.aborted) {
      rejectQueued()
      return
    }
    if (queue.length === 0 || outstanding.size >= maxOutstanding) {
      return
    }
    const batch = queue.splice(0, batchSize)
    const run = embedPendingBatch(input, batch, signal).finally(() => {
      outstanding.delete(run)
      if (queue.length > 0) {
        scheduleFlush()
      }
    })
    outstanding.add(run)
  }

  const scheduleFlush = () => {
    if (scheduled) {
      return
    }
    scheduled = true
    setTimeout(flush, 0)
  }

  return {
    embed(text) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        queue.push({ text, resolve, reject })
        if (queue.length >= batchSize) {
          flush()
          return
        }
        scheduleFlush()
      })
    },
    async drain() {
      while (queue.length > 0 || outstanding.size > 0) {
        if (signal?.aborted) {
          rejectQueued()
          signal.throwIfAborted()
        }
        flush()
        await Promise.all(Array.from(outstanding))
      }
    },
  }
}

async function embedPendingBatch(
  input: CreateIndexerInput,
  batch: { text: string; resolve(result: EmbeddingResult): void; reject(error: unknown): void }[],
  signal?: AbortSignal,
) {
  const errorResult = (error: unknown): EmbeddingResult => ({
    embeddingError: error instanceof Error ? error.message : String(error),
  })

  if (signal?.aborted) {
    for (const item of batch) {
      item.reject(signal.reason)
    }
    return
  }

  if (input.embedBatch) {
    await Promise.resolve()
      .then(
        () =>
          input.embedBatch?.(
            batch.map((item) => item.text),
            signal,
          ) ?? [],
      )
      .then((embeddings) => {
        for (const [index, item] of batch.entries()) {
          item.resolve(
            embeddings[index]
              ? { embedding: embeddings[index] }
              : { embeddingError: "embedding batch response omitted this input" },
          )
        }
      })
      .catch((error) => {
        const result = errorResult(error)
        for (const item of batch) {
          item.resolve(result)
        }
      })
    return
  }

  await Promise.all(
    batch.map(async (item) => {
      const result = await Promise.resolve()
        .then(() => input.embed(item.text, signal))
        .then((embedding) => ({ embedding }))
        .catch(errorResult)
      item.resolve(result)
    }),
  )
}

async function embedChunks(input: {
  input: CreateIndexerInput
  relativePath: string
  parsed: { language: string }
  chunks: ChunkRecord[]
  symbolsById: Record<string, SymbolRecord>
  fileDiagnostics: string[]
  embeddingBatcher: EmbeddingBatcher
}) {
  const fileChunks: CastIndex["chunks"] = {}
  const embeddedChunks: Array<{ chunk: ChunkRecord; embedded: EmbeddingResult }> = new Array(input.chunks.length)
  const concurrency =
    Math.max(1, input.input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY) *
    Math.max(1, input.input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE)
  await mapIndexesWithConcurrency(input.chunks.length, concurrency, async (index) => {
    const chunk = input.chunks[index]
    if (!chunk) {
      return
    }
    embeddedChunks[index] = {
      chunk,
      embedded: await input.embeddingBatcher.embed(
        embeddingText(
          input.relativePath,
          input.parsed.language,
          chunk,
          input.symbolsById,
          input.input.options.chunking.expansion,
        ),
      ),
    }
  })

  for (const { chunk, embedded } of embeddedChunks) {
    if ("embeddingError" in embedded) {
      input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`)
    }
    fileChunks[chunk.id] = { ...chunk, ...embedded }
  }
  return fileChunks
}

async function mapIndexesWithConcurrency(
  length: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
) {
  let next = 0
  let failed = false
  let firstError: unknown
  const workers = Array.from({ length: Math.min(concurrency, length) }, async () => {
    while (!failed && next < length) {
      const index = next
      next += 1
      try {
        await worker(index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  })
  await Promise.allSettled(workers)
  if (failed) {
    throw firstError
  }
}

function hasRunStore(
  store: Store,
): store is Store & Required<Pick<Store, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">> {
  return Boolean(store.beginIndexRun && store.getCompletedFile && store.writeFileResult && store.activateRun)
}

function hasBatchRunStore(store: IndexRunStore): store is IndexRunStore & Required<Pick<Store, "writeFileResults">> {
  return Boolean(store.writeFileResults)
}

function indexRunConfigHash(
  index: CastIndex,
  worktree: string,
  options: Parameters<typeof createIndexer>[0]["options"],
) {
  return stableHash({
    schemaVersion: index.metadata.schemaVersion,
    worktree,
    embeddingModel: index.metadata.embeddingModel,
    embeddingDimensions: index.metadata.embeddingDimensions,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    maxFileBytes: options.maxFileBytes,
    maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
    chunking: options.chunking,
  })
}

function stableHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

async function skipFileDiagnostic(
  relativePath: string,
  filePath: string,
  fileStat: FileStatMetadata | undefined,
  maxFileBytes: number,
): Promise<DiagnosticRecord | undefined> {
  if (!fileStat) {
    return
  }
  if (fileStat.sizeBytes > maxFileBytes) {
    return {
      code: "index.skipped_file",
      message: `${relativePath}: skipped file over maxFileBytes (${fileStat.sizeBytes} > ${maxFileBytes})`,
      filePath: relativePath,
    }
  }
  const sample = new Uint8Array(
    (await readFile(filePath)).subarray(0, Math.min(fileStat.sizeBytes, BINARY_SAMPLE_BYTES)),
  )
  if (isProbablyBinary(sample)) {
    return { code: "index.skipped_file", message: `${relativePath}: skipped binary file`, filePath: relativePath }
  }
}

function isProbablyBinary(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return false
  }
  let suspicious = 0
  for (const byte of bytes) {
    if (byte === BYTE_NUL) {
      return true
    }
    if (byte < CONTROL_BYTE_LIMIT && !isTextControlByte(byte)) {
      suspicious++
    }
  }
  return suspicious / bytes.length > BINARY_CONTROL_RATIO
}

function isTextControlByte(byte: number) {
  return TEXT_CONTROL_BYTES.has(byte)
}

const TEXT_CONTROL_BYTES = new Set([BYTE_BACKSPACE, BYTE_TAB, BYTE_LINE_FEED, BYTE_FORM_FEED, BYTE_CARRIAGE_RETURN])

function symbolsByFilePath(symbols: Record<string, SymbolRecord>): SymbolsByFilePath {
  const grouped: SymbolsByFilePath = new Map()
  for (const symbol of Object.values(symbols)) {
    const symbolsForFile = grouped.get(symbol.filePath)
    if (symbolsForFile) {
      symbolsForFile.push(symbol)
    } else {
      grouped.set(symbol.filePath, [symbol])
    }
  }
  return grouped
}

function canReuseFile(
  index: CastIndex,
  groupedSymbols: SymbolsByFilePath,
  file: CastIndex["files"][string] | undefined,
  relativePath: string,
  fingerprint: string,
  canReuseExistingRecords: boolean,
) {
  if (!canReuseExistingRecords || file?.path !== relativePath || file.fingerprint !== fingerprint) {
    return false
  }
  return canReuseFileRecords(index, groupedSymbols, file, relativePath)
}

function canReuseFileWithStat(
  index: CastIndex,
  groupedSymbols: SymbolsByFilePath,
  file: CastIndex["files"][string] | undefined,
  relativePath: string,
  fileStat: FileStatMetadata,
  canReuseExistingRecords: boolean,
) {
  if (
    !canReuseExistingRecords ||
    file?.path !== relativePath ||
    file.sizeBytes !== fileStat.sizeBytes ||
    file.mtimeMs !== fileStat.mtimeMs ||
    file.ctimeMs !== fileStat.ctimeMs
  ) {
    return false
  }
  return canReuseFileRecords(index, groupedSymbols, file, relativePath)
}

function canReuseFileRecords(
  index: CastIndex,
  groupedSymbols: SymbolsByFilePath,
  file: FileRecord,
  relativePath: string,
) {
  const chunks = file.chunkIds.map((id) => ({ id, chunk: index.chunks[id] }))
  const chunkIds = new Set(file.chunkIds)
  if (chunks.some((entry) => !entry.chunk || entry.chunk.id !== entry.id)) {
    return false
  }
  if (
    chunks.some(
      (entry) =>
        entry.chunk.filePath !== relativePath ||
        entry.chunk.language !== file.language ||
        entry.chunk.text.length === 0 ||
        !entry.chunk.embedding ||
        entry.chunk.embeddingError ||
        entry.chunk.symbolIds.some((id) => index.symbols[id]?.id !== id || index.symbols[id]?.filePath !== file.path) ||
        hasDanglingChunkReference(index, entry.chunk, chunkIds),
    )
  ) {
    return false
  }
  return (groupedSymbols.get(file.path) ?? []).every((symbol) => validSymbolRecord(index, symbol, file.path))
}

function validSymbolRecord(index: CastIndex, symbol: SymbolRecord, filePath: string) {
  return validSymbolIdentity(index, symbol, filePath) && validSymbolRelations(index, symbol, filePath)
}

function validSymbolIdentity(index: CastIndex, symbol: SymbolRecord, filePath: string) {
  return index.symbols[symbol.id]?.id === symbol.id && index.symbols[symbol.id]?.filePath === filePath
}

function validSymbolRelations(index: CastIndex, symbol: SymbolRecord, filePath: string) {
  return (
    validParentSymbol(index, symbol, filePath) &&
    symbol.childSymbolIds.every((id) => validSymbolId(index, id, filePath))
  )
}

function validParentSymbol(index: CastIndex, symbol: SymbolRecord, filePath: string) {
  return !symbol.parentSymbolId || validSymbolId(index, symbol.parentSymbolId, filePath)
}

function validSymbolId(index: CastIndex, id: string, filePath: string) {
  return index.symbols[id]?.id === id && index.symbols[id]?.filePath === filePath
}

function sameChunkingOptions(left: ChunkingOptions | undefined, right: ChunkingOptions) {
  return (
    left?.overlap === right.overlap &&
    left.expansion === right.expansion &&
    left.minSemanticNonWhitespaceChars === right.minSemanticNonWhitespaceChars
  )
}

function sameStringArray(left: string[] | undefined, right: string[]) {
  if (!left) {
    return false
  }
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function hasDanglingChunkReference(index: CastIndex, chunk: CastIndex["chunks"][string], chunkIds: Set<string>) {
  return referencedChunkIds(chunk).some((id) => !validChunkReference(index, chunkIds, id))
}

function referencedChunkIds(chunk: CastIndex["chunks"][string]) {
  return [chunk.parentChunkId, chunk.previousSiblingChunkId, chunk.nextSiblingChunkId, ...chunk.childChunkIds].filter(
    (id): id is string => Boolean(id),
  )
}

function validChunkReference(index: CastIndex, chunkIds: Set<string>, id: string) {
  return chunkIds.has(id) && Boolean(index.chunks[id])
}

function embeddingText(
  filePath: string,
  language: string,
  chunk: CastIndex["chunks"][string],
  symbols: CastIndex["symbols"],
  expansion: boolean,
) {
  const fields = [`path: ${filePath}`, `language: ${language}`]
  if (expansion) {
    fields.push(`chunk:\nkind: ${chunk.kind}\nrange: ${chunk.range.lineStart}-${chunk.range.lineEnd}`)
  }
  fields.push(
    `symbols:\n${chunk.symbolIds
      .map((id) => symbols[id])
      .filter((symbol) => symbol)
      .map((symbol) => `${symbol.kind} ${symbol.name}`)
      .join("\n")}`,
  )
  fields.push(`text:\n${chunk.text}`)
  return fields.join("\n")
}

async function* scanFiles(root: string, includeGlobs: string[], excludeGlobs: string[]) {
  const predicates = createScanPredicates(includeGlobs, excludeGlobs)
  for await (const file of walk(root, predicates)) {
    if (predicates.includes(file) && !predicates.excludes(file)) {
      yield file
    }
  }
}

function createScanPredicates(includeGlobs: string[], excludeGlobs: string[]): ScanPredicates {
  const includes = includeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }))
  const excludes = excludeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }))
  const directoryExcludes = excludeGlobs
    .filter((pattern) => canPruneDirectoryForExclude(pattern))
    .map((pattern) => new Minimatch(pattern, { dot: true }))
  return {
    includes: (filePath) => includes.some((matcher) => matcher.match(filePath)),
    excludes: (filePath) => excludes.some((matcher) => matcher.match(filePath)),
    excludesDirectory: (relativePath) => {
      const globPath = toGitignorePath(relativePath)
      return directoryExcludes.some((matcher) => matcher.match(globPath) || matcher.match(`${globPath}/`))
    },
  }
}

function canPruneDirectoryForExclude(pattern: string) {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(TRAILING_SLASHES, "")
  if (normalizedPattern.endsWith("/**")) {
    return true
  }
  return !new Minimatch(pattern, { dot: true }).hasMagic()
}

async function loadGitignore(root: string, prefix: string): Promise<GitignoreMatcher | undefined> {
  const matcher = ignore()
  try {
    matcher.add(await readFile(path.join(root, prefix, ".gitignore"), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
    return
  }
  return { base: prefix, matcher }
}

async function* walk(root: string, predicates: ScanPredicates): AsyncGenerator<string> {
  const queue: WalkDirectory[] = [{ prefix: "", gitignores: [] }]

  while (queue.length > 0) {
    const directory = queue.shift()
    if (!directory) {
      continue
    }
    for (const entry of await walkEntries(root, directory)) {
      const relative = path.join(directory.prefix, entry.name)
      if (shouldSkipWalkEntry(entry, relative, entry.gitignores)) {
        continue
      }
      if (entry.isDirectory()) {
        enqueueWalkDirectory(queue, relative, entry.gitignores, predicates)
        continue
      }
      yield relative
    }
  }
}

async function walkEntries(root: string, directory: WalkDirectory) {
  const entries = await readdir(path.join(root, directory.prefix), { withFileTypes: true })
  const localGitignore = await loadGitignore(root, directory.prefix)
  const gitignores = localGitignore ? [...directory.gitignores, localGitignore] : directory.gitignores
  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => Object.assign(entry, { gitignores }))
}

function shouldSkipWalkEntry(
  entry: Awaited<ReturnType<typeof walkEntries>>[number],
  relative: string,
  gitignores: GitignoreMatcher[],
) {
  return DEFAULT_IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink() || isGitignored(relative, gitignores)
}

function enqueueWalkDirectory(
  queue: WalkDirectory[],
  relative: string,
  gitignores: GitignoreMatcher[],
  predicates: ScanPredicates,
) {
  if (!predicates.excludesDirectory(relative)) {
    queue.push({ prefix: relative, gitignores })
  }
}

function isGitignored(relativePath: string, gitignores: GitignoreMatcher[]) {
  return gitignores.some(({ base, matcher }) => {
    const relativeToBase = base ? path.relative(base, relativePath) : relativePath
    return relativeToBase && !relativeToBase.startsWith("..") && !path.isAbsolute(relativeToBase)
      ? matcher.ignores(toGitignorePath(relativeToBase))
      : false
  })
}

function toGitignorePath(relativePath: string) {
  return relativePath.split(path.sep).join("/")
}

async function loadTextFileForIndexing(filePath: string): Promise<LoadedFile> {
  const bytes = await readFile(filePath)
  return {
    fingerprint: fingerprintBytes(bytes),
    text: new TextDecoder().decode(bytes),
  }
}

async function statFileForIndexing(filePath: string): Promise<FileStatMetadata | undefined> {
  try {
    const fileStat = await stat(filePath)
    return { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }
    throw error
  }
}

async function canReadFile(filePath: string) {
  try {
    await access(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function statIsOlderThanIndex(fileStat: FileStatMetadata, updatedAt: number) {
  return (
    updatedAt - fileStat.mtimeMs >= STAT_FAST_PATH_SETTLE_MS && updatedAt - fileStat.ctimeMs >= STAT_FAST_PATH_SETTLE_MS
  )
}

function fingerprintBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
