import type { ChunkRecord, SymbolRecord } from "./types.js"

function linkSymbolsToChunks(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  return chunks.map((chunk) => ({
    ...chunk,
    symbolIds: Object.values(symbols)
      .filter(
        (symbol) =>
          symbol.filePath === chunk.filePath &&
          containsRange(symbol.range.byteStart, symbol.range.byteEnd, chunk.range.byteStart, chunk.range.byteEnd),
      )
      .sort((left, right) => left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd)
      .map((symbol) => symbol.id),
  }))
}

function linkChunkTopology(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  const chunksWithParents = chunks.map((chunk) => ({ ...chunk, ...chunkRelations(chunk, chunks) }))
  return attachSiblingLinks(chunksWithParents, symbols)
}

function chunkRelations(chunk: ChunkRecord, chunks: ChunkRecord[]) {
  return {
    parentChunkId: parentChunkId(chunk, chunks),
    childChunkIds: childChunkIds(chunk, chunks),
  }
}

function parentChunkId(chunk: ChunkRecord, chunks: ChunkRecord[]) {
  return chunks
    .filter((candidate) => sameFileStrictParent(candidate, chunk))
    .sort((left, right) => rangeSize(left) - rangeSize(right))[0]?.id
}

function childChunkIds(chunk: ChunkRecord, chunks: ChunkRecord[]) {
  return chunks
    .filter((candidate) => sameFileStrictParent(chunk, candidate))
    .filter((candidate) => !hasIntermediateChild(chunk, candidate, chunks))
    .sort((left, right) => left.range.byteStart - right.range.byteStart)
    .map((candidate) => candidate.id)
}

function hasIntermediateChild(chunk: ChunkRecord, candidate: ChunkRecord, chunks: ChunkRecord[]) {
  return chunks.some((other) =>
    [
      other.filePath === chunk.filePath,
      other.id !== chunk.id,
      other.id !== candidate.id,
      containsChunk(chunk, other),
      containsChunk(other, candidate),
    ].every(Boolean),
  )
}

function sameFileStrictParent(parent: ChunkRecord, child: ChunkRecord) {
  return parent.filePath === child.filePath && parent.id !== child.id && containsChunk(parent, child)
}

function containsChunk(parent: ChunkRecord, child: ChunkRecord) {
  return strictlyContainsRange(parent.range.byteStart, parent.range.byteEnd, child.range.byteStart, child.range.byteEnd)
}

function attachSiblingLinks(chunksWithParents: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  const siblingGroups: Record<string, ChunkRecord[]> = {}
  for (const chunk of chunksWithParents) {
    const contextId = siblingContextId(chunk, symbols)
    siblingGroups[contextId] = [...(siblingGroups[contextId] ?? []), chunk]
  }
  const siblingIdsByChunkId = Object.fromEntries(
    Object.values(siblingGroups).flatMap((group) =>
      [...group]
        .sort((left, right) => left.range.byteStart - right.range.byteStart)
        .map((chunk, index, groupChunks) => [
          chunk.id,
          { previousSiblingChunkId: groupChunks[index - 1]?.id, nextSiblingChunkId: groupChunks[index + 1]?.id },
        ]),
    ),
  )

  return chunksWithParents.map((chunk) => ({
    ...chunk,
    previousSiblingChunkId: siblingIdsByChunkId[chunk.id]?.previousSiblingChunkId,
    nextSiblingChunkId: siblingIdsByChunkId[chunk.id]?.nextSiblingChunkId,
  }))
}

function siblingContextId(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>) {
  const symbol = symbols[chunk.symbolIds.at(-1) ?? ""]
  return `${chunk.filePath}:${chunk.parentChunkId ?? "root"}:${symbol?.id ?? "no-symbol"}`
}

function containsRange(parentStart: number, parentEnd: number, childStart: number, childEnd: number) {
  return parentStart <= childStart && childEnd <= parentEnd
}

function strictlyContainsRange(parentStart: number, parentEnd: number, childStart: number, childEnd: number) {
  return (
    containsRange(parentStart, parentEnd, childStart, childEnd) && (parentStart < childStart || childEnd < parentEnd)
  )
}

function rangeSize(chunk: ChunkRecord) {
  return chunk.range.byteEnd - chunk.range.byteStart
}

export { linkChunkTopology, linkSymbolsToChunks }
