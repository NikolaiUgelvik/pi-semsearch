import path from "node:path"
import { buildLexicalIndex } from "../search/lexical.js"
import type { CastIndex } from "../shared/types.js"
import { createEmbeddingBatcher, createFileResultWriter } from "./batching.js"
import type { ScannedFileInput } from "./file-processing.js"
import { flushQueuedReusedFileResults, processScannedFile } from "./file-processing.js"
import { statFileForIndexing } from "./io.js"
import { scanFiles, shouldIndexSingleFile, worktreeRelativePath } from "./paths.js"
import { canReuseExistingIndexRecords, sameStringArray, symbolsByFilePath } from "./reuse.js"
import { stableHash, stableStringify } from "./stable.js"
import type {
  CreateIndexerInput,
  EmbeddingBatcher,
  FileResultWriter,
  IndexRunStore,
  RefreshState,
  ScannerFileResult,
  ScannerStore,
} from "./types.js"

const DEFAULT_FILE_CONCURRENCY = 4

export interface FileResult extends ScannerFileResult {}

export interface Store extends Omit<ScannerStore, "getCompletedFile" | "writeFileResult" | "writeFileResults"> {
  getCompletedFile?(runId: string, filePath: string, fingerprint: string): Promise<FileResult | undefined>
  writeFileResult?(runId: string, fileResult: FileResult): Promise<void>
  writeFileResults?(runId: string, fileResults: FileResult[]): Promise<void>
}

export interface PublicCreateIndexerInput extends Omit<CreateIndexerInput, "store"> {
  store: Store
}

export function createIndexer(input: PublicCreateIndexerInput) {
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
      await persistRefreshState({
        index,
        store,
        runStore,
        run: runController.run,
        ensureRun: runController.ensureRun,
        scannerInput: input,
        state,
        lexicalIndex,
      })
      return index
    },
    async refreshFile(filePath: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const store = input.store
      const index = await store.read()
      signal?.throwIfAborted()
      if (!canSingleFileRefresh(index, input)) {
        return this.refresh(signal)
      }

      const relativePath = worktreeRelativePath(input.worktree, filePath)
      if (!relativePath) {
        return index
      }
      const previousState = singleFileStateSnapshot(index, relativePath)
      const state = createSingleFileRefreshState(index, input, relativePath)
      const shouldIndex = await shouldIndexSingleFile(input, relativePath)
      const absolutePath = path.join(input.worktree, relativePath)
      const fileStat = shouldIndex ? await statFileForIndexing(absolutePath) : undefined
      if (fileStat) {
        const embeddingBatcher = createEmbeddingBatcher(input, signal)
        await processScannedFile({
          input,
          index,
          state,
          relativePath,
          runStore: undefined,
          run: () => undefined,
          ensureRun: async () => undefined,
          embeddingBatcher,
          fileResultWriter: createFileResultWriter({ runStore: undefined, run: () => undefined }),
          signal,
        })
        signal?.throwIfAborted()
        await embeddingBatcher.drain()
      }

      signal?.throwIfAborted()
      state.metadataDiagnostics.sort()
      const lexicalIndex = buildSingleFileLexicalIndex(state, relativePath)
      if (!singleFileRefreshChanged(index, relativePath, state, lexicalIndex, previousState)) {
        return index
      }
      await persistRefreshState({
        index,
        store,
        runStore: undefined,
        run: () => undefined,
        ensureRun: async () => undefined,
        scannerInput: input,
        state,
        lexicalIndex,
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

function canSingleFileRefresh(index: CastIndex, input: CreateIndexerInput) {
  return (
    index.metadata.status === "ready" &&
    index.metadata.worktree === input.worktree &&
    sameScannerOptions(index.metadata, input.options) &&
    canReuseExistingIndexRecords(index, input)
  )
}

function createSingleFileRefreshState(index: CastIndex, input: CreateIndexerInput, relativePath: string): RefreshState {
  const state = createRefreshState(index, input)
  state.nextFiles = { ...index.files }
  state.nextChunks = { ...index.chunks }
  state.nextSymbols = { ...index.symbols }
  state.metadataDiagnostics = (index.metadata.diagnostics ?? []).filter(
    (diagnostic) => !(diagnosticBelongsToFile(diagnostic, relativePath) || isSourceHydrationDiagnostic(diagnostic)),
  )
  state.metadataDiagnosticDetails = (index.metadata.diagnosticDetails ?? []).filter(
    (diagnostic) => !(diagnostic.filePath === relativePath || isSourceHydrationDiagnosticCode(diagnostic.code)),
  )
  removeFileRecordsFromState(state, relativePath)
  return state
}

function removeFileRecordsFromState(state: RefreshState, relativePath: string) {
  delete state.nextFiles[relativePath]
  for (const [chunkId, chunk] of Object.entries(state.nextChunks)) {
    if (chunk.filePath === relativePath) {
      delete state.nextChunks[chunkId]
    }
  }
  for (const [symbolId, symbol] of Object.entries(state.nextSymbols)) {
    if (symbol.filePath === relativePath) {
      delete state.nextSymbols[symbolId]
    }
  }
}

function diagnosticBelongsToFile(diagnostic: string, relativePath: string) {
  return diagnostic === relativePath || diagnostic.startsWith(`${relativePath}:`)
}

function isSourceHydrationDiagnostic(diagnostic: string) {
  return (
    diagnostic.startsWith("source fingerprint mismatch for ") ||
    diagnostic.startsWith("source read failed for ") ||
    diagnostic.startsWith("source range invalid for ")
  )
}

function isSourceHydrationDiagnosticCode(code: string) {
  return code === "source.mismatch" || code === "source.read_failed"
}

function singleFileStateSnapshot(index: CastIndex, relativePath: string) {
  return stableStringify({
    file: index.files[relativePath],
    chunks: Object.fromEntries(Object.entries(index.chunks).filter(([, chunk]) => chunk.filePath === relativePath)),
    symbols: Object.fromEntries(Object.entries(index.symbols).filter(([, symbol]) => symbol.filePath === relativePath)),
    diagnostics: index.metadata.diagnostics ?? [],
    diagnosticDetails: index.metadata.diagnosticDetails ?? [],
  })
}

function buildSingleFileLexicalIndex(state: RefreshState, relativePath: string) {
  const changedChunks = Object.fromEntries(
    Object.entries(state.nextChunks).filter(([, chunk]) => chunk.filePath === relativePath),
  )
  const indexedChangedChunks = buildLexicalIndex(changedChunks, state.nextSymbols).chunks
  const chunks = { ...state.nextChunks, ...indexedChangedChunks }
  return { lexical: lexicalIndexFromChunks(chunks), chunks }
}

function lexicalIndexFromChunks(chunks: CastIndex["chunks"]) {
  const documentFrequencies: Record<string, number> = Object.create(null)
  let documentCount = 0
  let totalLength = 0
  for (const chunk of Object.values(chunks)) {
    const lexical = chunk.lexical
    if (!lexical) {
      continue
    }
    documentCount += 1
    totalLength += lexical.length
    for (const term of Object.keys(lexical.termFrequencies)) {
      documentFrequencies[term] = (documentFrequencies[term] ?? 0) + 1
    }
  }
  return {
    documentCount,
    averageDocumentLength: documentCount === 0 ? 0 : totalLength / documentCount,
    documentFrequencies,
  }
}

function singleFileRefreshChanged(
  index: CastIndex,
  relativePath: string,
  state: RefreshState,
  lexicalIndex: { chunks: CastIndex["chunks"] },
  previousState: string,
) {
  const nextState = stableStringify({
    file: state.nextFiles[relativePath],
    chunks: Object.fromEntries(
      Object.entries(lexicalIndex.chunks).filter(([, chunk]) => chunk.filePath === relativePath),
    ),
    symbols: Object.fromEntries(
      Object.entries(state.nextSymbols).filter(([, symbol]) => symbol.filePath === relativePath),
    ),
    diagnostics: state.metadataDiagnostics,
    diagnosticDetails: state.metadataDiagnosticDetails,
  })
  return previousState !== nextState || Object.keys(index.files).length !== Object.keys(state.nextFiles).length
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
      const workerInput: ScannedFileInput = { ...input, relativePath }
      const worker = processScannedFile(workerInput)
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

async function persistRefreshState(input: {
  index: CastIndex
  store: Store
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
  scannerInput: CreateIndexerInput
  state: RefreshState
  lexicalIndex: { lexical: CastIndex["lexical"]; chunks: CastIndex["chunks"] }
}) {
  input.index.files = input.state.nextFiles
  input.index.chunks = input.lexicalIndex.chunks
  input.index.symbols = input.state.nextSymbols
  input.index.lexical = input.lexicalIndex.lexical
  applyScannerMetadata(input.index, input.scannerInput)
  input.index.metadata.diagnostics = input.state.metadataDiagnostics
  input.index.metadata.diagnosticDetails = input.state.metadataDiagnosticDetails
  input.index.metadata.status = "ready"
  input.index.metadata.updatedAt = Date.now()
  await persistRefreshedIndex(input)
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

function hasRunStore(
  store: Store,
): store is Store & Required<Pick<Store, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">> {
  return Boolean(store.beginIndexRun && store.getCompletedFile && store.writeFileResult && store.activateRun)
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
