import { castChunks, type SyntaxNode } from "./cast.js"
import { fallbackChunks } from "./fallback.js"
import { createSourceIndex, type SourceIndex } from "./range.js"
import { embedChunks } from "./scanner-batching.js"
import type {
  CreateIndexerInput,
  EmbeddingBatcher,
  FileResultWriter,
  FileStatMetadata,
  IndexRunStore,
  RefreshState,
} from "./scanner-types.js"
import { assignSymbolsToChunks, attachTopology, extractSymbols } from "./topology.js"
import type { ChunkRecord, SymbolRecord } from "./types.js"

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

export { indexFile }
