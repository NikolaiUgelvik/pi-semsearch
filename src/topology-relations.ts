import type { ChunkRecord, SymbolRecord } from "./types.js"

function linkSymbolsToChunks(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  const symbolsByFile = groupByFile(Object.values(symbols))
  return chunks.map((chunk) => ({
    ...chunk,
    symbolIds: (symbolsByFile[chunk.filePath] ?? [])
      .filter((symbol) =>
        containsRange(symbol.range.byteStart, symbol.range.byteEnd, chunk.range.byteStart, chunk.range.byteEnd),
      )
      .sort((left, right) => left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd)
      .map((symbol) => symbol.id),
  }))
}

function linkChunkTopology(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>) {
  const relations = chunkRelations(chunks)
  const chunksWithParents = chunks.map((chunk) => ({
    ...chunk,
    parentChunkId: relations[chunk.id]?.parentChunkId,
    childChunkIds: relations[chunk.id]?.childChunkIds ?? [],
  }))
  return attachSiblingLinks(chunksWithParents, symbols)
}

function chunkRelations(chunks: ChunkRecord[]) {
  const relations: Record<string, { parentChunkId?: string; childChunkIds: string[] }> = {}
  for (const chunk of chunks) {
    relations[chunk.id] = { childChunkIds: [] }
  }

  for (const fileChunks of Object.values(groupByFile(chunks))) {
    const stack: ChunkRecord[] = []
    for (const chunk of [...fileChunks].sort(compareForTopology)) {
      while (stack.length > 0 && !containsChunk(stack.at(-1) as ChunkRecord, chunk)) {
        stack.pop()
      }
      const parent = stack.at(-1)
      if (parent) {
        relations[chunk.id].parentChunkId = parent.id
        relations[parent.id].childChunkIds.push(chunk.id)
      }
      stack.push(chunk)
    }
  }

  return relations
}

function containsChunk(parent: ChunkRecord, child: ChunkRecord) {
  return strictlyContainsRange(parent.range.byteStart, parent.range.byteEnd, child.range.byteStart, child.range.byteEnd)
}

function compareForTopology(left: ChunkRecord, right: ChunkRecord) {
  return left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd
}

function groupByFile<T extends { filePath: string }>(items: T[]) {
  const groups: Record<string, T[]> = {}
  for (const item of items) {
    groups[item.filePath] = [...(groups[item.filePath] ?? []), item]
  }
  return groups
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

export { linkChunkTopology, linkSymbolsToChunks }
