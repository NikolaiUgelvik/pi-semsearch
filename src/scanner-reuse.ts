import { stableStringify } from "./scanner-stable.js"
import type {
  CreateIndexerInput,
  ScannerFileResult as FileResult,
  FileStatMetadata,
  RefreshState,
  SymbolsByFilePath,
} from "./scanner-types.js"
import type { CastIndex, ChunkingOptions, ChunkRecord, FileRecord, SymbolRecord } from "./types.js"

function canReuseExistingIndexRecords(index: CastIndex, input: CreateIndexerInput) {
  return (
    index.metadata.maxChunkNonWhitespaceChars === input.options.maxChunkNonWhitespaceChars &&
    sameChunkingOptions(index.metadata.chunking, input.options.chunking)
  )
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

export {
  canReuseCompletedFile,
  canReuseExistingIndexRecords,
  canReuseFile,
  canReuseFileWithStat,
  reuseCompletedFileRecords,
  reuseFileRecords,
  sameStringArray,
  symbolsByFilePath,
}
