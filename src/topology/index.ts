import type { SyntaxNode } from "../parsing/cast.js"
import type { SourceIndex } from "../parsing/range.js"
import type { ChunkRecord, SymbolRecord } from "../shared/types.js"
import { linkChunkTopology, linkSymbolsToChunks } from "./relations.js"
import {
  summaryChunkBreadcrumbs,
  summaryChunkMatchesSource,
  summaryExpandWithParentContext,
  summarySummarizeChunk,
  summarySummarizeTopology,
} from "./summary.js"
import { extractSymbolRecords } from "./symbols.js"

function extractSymbols(input: { filePath: string; source: string; sourceIndex?: SourceIndex; nodes: SyntaxNode[] }) {
  return extractSymbolRecords(input)
}

function assignSymbolsToChunks(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  return linkSymbolsToChunks(chunks, symbols)
}

function attachTopology(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  return linkChunkTopology(chunks, symbols)
}

function expandWithParentContext(input: Parameters<typeof summaryExpandWithParentContext>[0]) {
  return summaryExpandWithParentContext(input)
}

function summarizeTopology(...input: Parameters<typeof summarySummarizeTopology>) {
  return summarySummarizeTopology(...input)
}

function summarizeChunk(...input: Parameters<typeof summarySummarizeChunk>) {
  return summarySummarizeChunk(...input)
}

function chunkMatchesSource(...input: Parameters<typeof summaryChunkMatchesSource>) {
  return summaryChunkMatchesSource(...input)
}

function chunkBreadcrumbs(...input: Parameters<typeof summaryChunkBreadcrumbs>) {
  return summaryChunkBreadcrumbs(...input)
}

export {
  assignSymbolsToChunks,
  attachTopology,
  chunkBreadcrumbs,
  chunkMatchesSource,
  expandWithParentContext,
  extractSymbols,
  summarizeChunk,
  summarizeTopology,
}
