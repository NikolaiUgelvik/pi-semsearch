import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import ignore, { type Ignore } from "ignore"
import { minimatch } from "minimatch"
import { castChunks, type SyntaxNode } from "./cast.js"
import { fallbackChunks } from "./fallback.js"
import { buildLexicalIndex } from "./lexical.js"
import { assignSymbolsToChunks, attachTopology, extractSymbols } from "./topology.js"
import type { CastIndex, ChunkingOptions, ChunkRecord, FileRecord, SymbolRecord } from "./types.js"

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
  activateRun?(runId: string, index: CastIndex): Promise<void>
}
type GitignoreMatcher = { base: string; matcher: Ignore }
type CreateIndexerInput = Parameters<typeof createIndexer>[0]
type IndexRunStore = Store &
  Required<Pick<Store, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">>
type RefreshState = {
  nextFiles: CastIndex["files"]
  nextChunks: CastIndex["chunks"]
  nextSymbols: CastIndex["symbols"]
  metadataDiagnostics: string[]
  canReuseExistingRecords: boolean
  changed: boolean
}
const BINARY_SAMPLE_BYTES = Number("16") * Number("1024")
const BYTE_NUL = 0
const BYTE_BACKSPACE = 8
const BYTE_TAB = 9
const BYTE_LINE_FEED = 10
const BYTE_FORM_FEED = 12
const BYTE_CARRIAGE_RETURN = 13
const CONTROL_BYTE_LIMIT = 32
const BINARY_CONTROL_RATIO = 0.3

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
  }
  store: Store
  parse(filePath: string, source: string): Promise<{ language: string; root?: SyntaxNode }>
  embed(text: string): Promise<number[]>
}) {
  return {
    async refresh() {
      const store = input.store
      const index = await store.read()
      const initialStatus = index.metadata.status
      const canReuseExistingRecords =
        index.metadata.maxChunkNonWhitespaceChars === input.options.maxChunkNonWhitespaceChars &&
        sameChunkingOptions(index.metadata.chunking, input.options.chunking)
      const runConfigHash = indexRunConfigHash(index, input.options)
      const runStore = hasRunStore(store) && initialStatus !== "ready" ? store : undefined
      const files = await scanFiles(input.worktree, input.options.includeGlobs, input.options.excludeGlobs)
      const nextFiles: CastIndex["files"] = {}
      const nextChunks: CastIndex["chunks"] = {}
      const nextSymbols: CastIndex["symbols"] = {}
      const metadataDiagnostics: string[] = []
      let changed = false
      let run: { runId: string } | undefined

      const markIndexing = () => {
        index.metadata.status = "indexing"
        index.metadata.worktree = input.worktree
        index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars
        index.metadata.chunking = input.options.chunking
      }
      const ensureRun = async () => {
        if (!runStore) {
          return
        }
        if (!run) {
          markIndexing()
          run = await runStore.beginIndexRun({ configHash: runConfigHash, metadata: index.metadata })
        }
        return run
      }

      for (const relativePath of files) {
        await processScannedFile({
          input,
          index,
          state: { nextFiles, nextChunks, nextSymbols, metadataDiagnostics, canReuseExistingRecords, changed },
          relativePath,
          runStore,
          run: () => run,
          ensureRun,
        }).then((nextChanged) => {
          changed = nextChanged
        })
      }

      const lexicalIndex = buildLexicalIndex(nextChunks, nextSymbols)
      const hasFileSetChange = !sameStringArray(Object.keys(index.files).sort(), Object.keys(nextFiles).sort())
      const hasDiagnosticsChange = !sameStringArray(index.metadata.diagnostics, metadataDiagnostics)
      if (
        canSkipRefresh(index, input.worktree, changed, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange)
      ) {
        return index
      }

      index.files = nextFiles
      index.chunks = lexicalIndex.chunks
      index.symbols = nextSymbols
      index.lexical = lexicalIndex.lexical
      index.metadata.worktree = input.worktree
      index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars
      index.metadata.chunking = input.options.chunking
      index.metadata.diagnostics = metadataDiagnostics
      index.metadata.status = "ready"
      index.metadata.updatedAt = Date.now()
      await persistRefreshedIndex({ index, store, runStore, run: () => run, ensureRun })
      return index
    },
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

async function processScannedFile(input: {
  input: CreateIndexerInput
  index: CastIndex
  state: RefreshState
  relativePath: string
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
  ensureRun: () => Promise<{ runId: string } | undefined>
}) {
  const absolutePath = path.join(input.input.worktree, input.relativePath)
  const file = Bun.file(absolutePath)
  const skipDiagnostic = await skipFileDiagnostic(input.relativePath, file, input.input.options.maxFileBytes)
  if (skipDiagnostic) {
    input.state.metadataDiagnostics.push(skipDiagnostic)
    return input.state.changed
  }
  const currentFingerprint = await fingerprint(absolutePath)
  const previousFile = input.index.files[input.relativePath]
  if (
    canReuseFile(input.index, previousFile, input.relativePath, currentFingerprint, input.state.canReuseExistingRecords)
  ) {
    reuseFileRecords(input.index, previousFile, input.state)
    return input.state.changed
  }

  const activeRun = await input.ensureRun()
  const completed = activeRun
    ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
    : undefined
  if (completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint)) {
    reuseCompletedFileRecords(completed, input.state)
    return true
  }

  await indexFile({ ...input, absolutePath, currentFingerprint })
  return true
}

function reuseFileRecords(index: CastIndex, file: FileRecord, state: RefreshState) {
  state.nextFiles[file.path] = file
  for (const chunkId of file.chunkIds) {
    if (index.chunks[chunkId]) {
      state.nextChunks[chunkId] = index.chunks[chunkId]
    }
  }
  for (const symbol of Object.values(index.symbols).filter((symbol) => symbol.filePath === file.path)) {
    state.nextSymbols[symbol.id] = symbol
  }
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
  return canReuseFile(completedIndex, completed.file, relativePath, currentFingerprint, true)
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
  runStore: IndexRunStore | undefined
  run: () => { runId: string } | undefined
}) {
  const text = await Bun.file(input.absolutePath).text()
  const parsed = await input.input.parse(input.absolutePath, text).catch((error) => ({
    language: "text",
    root: undefined,
    diagnostic: String(error),
  }))
  const rawChunks = parsed.root
    ? castChunks({
        filePath: input.relativePath,
        language: parsed.language,
        source: text,
        root: parsed.root,
        maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
        chunking: input.input.options.chunking,
      })
    : fallbackChunks({
        filePath: input.relativePath,
        language: parsed.language,
        text,
        maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
      })
  const symbols = parsed.root
    ? extractSymbols({ filePath: input.relativePath, source: text, nodes: parsed.root.children })
    : []
  const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]))
  const chunks = attachTopology(assignSymbolsToChunks(rawChunks, symbolsById), symbolsById)
  const fileDiagnostics = "diagnostic" in parsed ? [String(parsed.diagnostic)] : []
  const fileChunks = await embedChunks({ ...input, parsed, chunks, symbolsById, fileDiagnostics })
  Object.assign(input.state.nextChunks, fileChunks)
  for (const symbol of symbols) {
    input.state.nextSymbols[symbol.id] = symbol
  }
  const fileRecord = {
    path: input.relativePath,
    language: parsed.language,
    fingerprint: input.currentFingerprint,
    chunkIds: chunks.map((chunk) => chunk.id),
    diagnostics: fileDiagnostics,
  }
  input.state.nextFiles[input.relativePath] = fileRecord
  const run = input.run()
  if (run && input.runStore) {
    await input.runStore.writeFileResult(run.runId, {
      file: fileRecord,
      chunks: fileChunks,
      symbols: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
    })
  }
}

async function embedChunks(input: {
  input: CreateIndexerInput
  relativePath: string
  parsed: { language: string }
  chunks: ChunkRecord[]
  symbolsById: Record<string, SymbolRecord>
  fileDiagnostics: string[]
}) {
  const fileChunks: CastIndex["chunks"] = {}
  for (const chunk of input.chunks) {
    const embedded = await input.input
      .embed(
        embeddingText(
          input.relativePath,
          input.parsed.language,
          chunk,
          input.symbolsById,
          input.input.options.chunking.expansion,
        ),
      )
      .then((embedding) => ({ embedding }))
      .catch((error) => ({ embeddingError: error instanceof Error ? error.message : String(error) }))
    if ("embeddingError" in embedded) {
      input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`)
    }
    fileChunks[chunk.id] = { ...chunk, ...embedded }
  }
  return fileChunks
}

function hasRunStore(
  store: Store,
): store is Store & Required<Pick<Store, "beginIndexRun" | "getCompletedFile" | "writeFileResult" | "activateRun">> {
  return Boolean(store.beginIndexRun && store.getCompletedFile && store.writeFileResult && store.activateRun)
}

function indexRunConfigHash(index: CastIndex, options: Parameters<typeof createIndexer>[0]["options"]) {
  return stableHash({
    schemaVersion: index.metadata.schemaVersion,
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
  file: { size: number; slice(start?: number, end?: number): Blob },
  maxFileBytes: number,
) {
  if (file.size > maxFileBytes) {
    return `${relativePath}: skipped file over maxFileBytes (${file.size} > ${maxFileBytes})`
  }
  const sample = new Uint8Array(await file.slice(0, Math.min(file.size, BINARY_SAMPLE_BYTES)).arrayBuffer())
  if (isProbablyBinary(sample)) {
    return `${relativePath}: skipped binary file`
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

function canReuseFile(
  index: CastIndex,
  file: CastIndex["files"][string] | undefined,
  relativePath: string,
  fingerprint: string,
  canReuseExistingRecords: boolean,
) {
  if (!canReuseExistingRecords || file?.path !== relativePath || file.fingerprint !== fingerprint) {
    return false
  }
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
  return Object.values(index.symbols)
    .filter((symbol) => symbol.filePath === file.path)
    .every((symbol) => validSymbolRecord(index, symbol, file.path))
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

function sameStringArray(left: string[], right: string[]) {
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
    const lineEnd = chunk.text.endsWith("\n")
      ? Math.max(chunk.range.lineStart, chunk.range.lineEnd - 1)
      : chunk.range.lineEnd
    fields.push(`chunk:\nkind: ${chunk.kind}\nrange: ${chunk.range.lineStart}-${lineEnd}`)
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

async function scanFiles(root: string, includeGlobs: string[], excludeGlobs: string[]) {
  const files = await walk(root)
  return files.filter(
    (file) =>
      includeGlobs.some((pattern) => minimatch(file, pattern)) &&
      !excludeGlobs.some((pattern) => minimatch(file, pattern)),
  )
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

async function walk(root: string, prefix = "", inheritedGitignores: GitignoreMatcher[] = []): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  const localGitignore = await loadGitignore(root, prefix)
  const gitignores = localGitignore ? [...inheritedGitignores, localGitignore] : inheritedGitignores
  const ignored = new Set([".git", "node_modules", "dist", "build", ".cache"])
  const nested = await Promise.all(
    entries
      .filter((entry) => {
        const relative = path.join(prefix, entry.name)
        return !(ignored.has(entry.name) || entry.isSymbolicLink() || isGitignored(relative, gitignores))
      })
      .map((entry) => {
        const relative = path.join(prefix, entry.name)
        return entry.isDirectory() ? walk(root, relative, gitignores) : Promise.resolve([relative])
      }),
  )
  return nested.flat()
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

async function fingerprint(filePath: string) {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(filePath).arrayBuffer()))
    .digest("hex")
}
