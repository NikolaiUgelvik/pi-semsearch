import { textForByteSlice } from "./range.js"
import type { ChunkRecord, SearchResultTopology, SymbolRecord, TopologyNode } from "./types.js"

const LEADING_SEPARATOR_PATTERN = /^[,;]\s*/u
const SNIPPET_LABEL_MAX_LENGTH = 80
const SNIPPET_LABEL_PREFIX_LENGTH = 77

function expandWithParentContext(input: {
  chunk: ChunkRecord
  symbols: Record<string, SymbolRecord>
  source: string
  maxContextChars: number
}) {
  const chunkSymbols = input.chunk.symbolIds
    .map((id) => input.symbols[id])
    .filter((symbol): symbol is SymbolRecord => Boolean(symbol))
  const parent = chunkSymbols[0]
  const breadcrumbs = chunkSymbols.map((symbol) => `${symbol.kind} ${symbol.name}`)

  if (!parent) {
    return { breadcrumbs }
  }

  const parentText = textForByteSlice(input.source, parent.range.byteStart, parent.range.byteEnd).trimEnd()
  if (parentText.length <= input.maxContextChars) {
    return { breadcrumbs, parentText, parentRange: parent.range }
  }

  return {
    breadcrumbs,
    parentText:
      `${breadcrumbs[0]}\n${textForByteSlice(input.source, input.chunk.range.byteStart, input.chunk.range.byteEnd).trimEnd()}`.slice(
        0,
        input.maxContextChars,
      ),
    parentRange: parent.range,
  }
}

function summarizeTopology(
  chunk: ChunkRecord,
  chunks: Record<string, ChunkRecord>,
  symbols: Record<string, SymbolRecord>,
): SearchResultTopology {
  return {
    chunk: summarizeChunk(chunk, symbols),
    ...optionalChunk(chunks, chunk.parentChunkId, symbols, "parent"),
    children: chunk.childChunkIds.flatMap((id) => {
      const child = chunks[id]
      return child ? [summarizeChunk(child, symbols)] : []
    }),
    ...optionalChunk(chunks, chunk.previousSiblingChunkId, symbols, "previousSibling"),
    ...optionalChunk(chunks, chunk.nextSiblingChunkId, symbols, "nextSibling"),
    symbols: symbolBreadcrumbs(chunk, symbols),
  }
}

function summarizeChunk(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>): TopologyNode {
  return {
    id: chunk.id,
    label: labelForChunk(chunk, symbols),
    range: rangeLabel(chunk),
  }
}

function chunkMatchesSource(source: string, chunk: ChunkRecord) {
  return textForByteSlice(source, chunk.range.byteStart, chunk.range.byteEnd) === chunk.text
}

function chunkBreadcrumbs(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  return chunk.symbolIds.flatMap((id) => (symbols[id] ? [`${symbols[id].kind} ${symbols[id].name}`] : []))
}

function optionalChunk<Key extends "parent" | "previousSibling" | "nextSibling">(
  chunks: Record<string, ChunkRecord>,
  id: string | undefined,
  symbols: Record<string, SymbolRecord>,
  key: Key,
): Partial<Record<Key, TopologyNode>> {
  const chunk = id ? chunks[id] : undefined
  return chunk ? ({ [key]: summarizeChunk(chunk, symbols) } as Partial<Record<Key, TopologyNode>>) : {}
}

function labelForChunk(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  if (chunk.kind === "file") {
    return `file ${chunk.filePath}`
  }
  const localSymbol = nearestLocalSymbol(chunk, symbols)
  if (localSymbol) {
    return `${localSymbol.kind} ${localSymbol.name}`
  }
  const localLabel = localSnippetLabel(chunk)
  if (localLabel) {
    return `${chunk.kind} ${withoutDuplicateKindPrefix(chunk.kind, localLabel)}`
  }
  const enclosingSymbol = nearestEnclosingSymbol(chunk, symbols)
  return enclosingSymbol ? `${enclosingSymbol.kind} ${enclosingSymbol.name}` : `${chunk.kind} chunk`
}

function nearestLocalSymbol(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  return [...chunk.symbolIds]
    .reverse()
    .flatMap((id) => (symbols[id] ? [symbols[id]] : []))
    .find((symbol) => rangesTightlyOverlap(symbol, chunk))
}

function nearestEnclosingSymbol(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  return [...chunk.symbolIds]
    .reverse()
    .flatMap((id) => (symbols[id] ? [symbols[id]] : []))
    .find((symbol) => symbol.range.byteStart <= chunk.range.byteStart && chunk.range.byteEnd <= symbol.range.byteEnd)
}

function rangesTightlyOverlap(symbol: SymbolRecord, chunk: ChunkRecord) {
  return symbol.range.byteStart >= chunk.range.byteStart && symbol.range.byteStart <= chunk.range.byteEnd
}

function withoutDuplicateKindPrefix(kind: ChunkRecord["kind"], label: string) {
  const prefixes = kind === "function" ? ["async function ", "function "] : [`${kind} `]
  return prefixes.reduce(
    (current, prefix) => (current.startsWith(prefix) ? current.slice(prefix.length) : current),
    label,
  )
}

function localSnippetLabel(chunk: ChunkRecord) {
  const firstLine = chunk.text
    .split("\n")
    .map((line) => line.trim().replace(LEADING_SEPARATOR_PATTERN, "").trim())
    .find((line) => line.length > 0)
  if (!firstLine) {
    return
  }
  return firstLine.length > SNIPPET_LABEL_MAX_LENGTH
    ? `${firstLine.slice(0, SNIPPET_LABEL_PREFIX_LENGTH)}...`
    : firstLine
}

function rangeLabel(chunk: ChunkRecord) {
  if (chunk.range.lineStart === chunk.range.lineEnd) {
    return `${chunk.filePath}:${chunk.range.lineStart}`
  }
  return `${chunk.filePath}:${chunk.range.lineStart}-${chunk.range.lineEnd}`
}

function symbolBreadcrumbs(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  return chunkBreadcrumbs(chunk, symbols)
}

export {
  chunkBreadcrumbs as summaryChunkBreadcrumbs,
  chunkMatchesSource as summaryChunkMatchesSource,
  expandWithParentContext as summaryExpandWithParentContext,
  summarizeChunk as summarySummarizeChunk,
  summarizeTopology as summarySummarizeTopology,
}
