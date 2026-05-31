function linkSymbolsToChunks(chunks, symbols) {
    return chunks.map((chunk) => ({
        ...chunk,
        symbolIds: Object.values(symbols)
            .filter((symbol) => symbol.filePath === chunk.filePath &&
            containsRange(symbol.range.byteStart, symbol.range.byteEnd, chunk.range.byteStart, chunk.range.byteEnd))
            .sort((left, right) => left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd)
            .map((symbol) => symbol.id),
    }));
}
function linkChunkTopology(chunks, symbols) {
    const chunksWithParents = chunks.map((chunk) => ({ ...chunk, ...chunkRelations(chunk, chunks) }));
    return attachSiblingLinks(chunksWithParents, symbols);
}
function chunkRelations(chunk, chunks) {
    return {
        parentChunkId: parentChunkId(chunk, chunks),
        childChunkIds: childChunkIds(chunk, chunks),
    };
}
function parentChunkId(chunk, chunks) {
    return chunks
        .filter((candidate) => sameFileStrictParent(candidate, chunk))
        .sort((left, right) => rangeSize(left) - rangeSize(right))[0]?.id;
}
function childChunkIds(chunk, chunks) {
    return chunks
        .filter((candidate) => sameFileStrictParent(chunk, candidate))
        .filter((candidate) => !hasIntermediateChild(chunk, candidate, chunks))
        .sort((left, right) => left.range.byteStart - right.range.byteStart)
        .map((candidate) => candidate.id);
}
function hasIntermediateChild(chunk, candidate, chunks) {
    return chunks.some((other) => [
        other.filePath === chunk.filePath,
        other.id !== chunk.id,
        other.id !== candidate.id,
        containsChunk(chunk, other),
        containsChunk(other, candidate),
    ].every(Boolean));
}
function sameFileStrictParent(parent, child) {
    return parent.filePath === child.filePath && parent.id !== child.id && containsChunk(parent, child);
}
function containsChunk(parent, child) {
    return strictlyContainsRange(parent.range.byteStart, parent.range.byteEnd, child.range.byteStart, child.range.byteEnd);
}
function attachSiblingLinks(chunksWithParents, symbols) {
    const siblingGroups = {};
    for (const chunk of chunksWithParents) {
        const contextId = siblingContextId(chunk, symbols);
        siblingGroups[contextId] = [...(siblingGroups[contextId] ?? []), chunk];
    }
    const siblingIdsByChunkId = Object.fromEntries(Object.values(siblingGroups).flatMap((group) => [...group]
        .sort((left, right) => left.range.byteStart - right.range.byteStart)
        .map((chunk, index, groupChunks) => [
        chunk.id,
        { previousSiblingChunkId: groupChunks[index - 1]?.id, nextSiblingChunkId: groupChunks[index + 1]?.id },
    ])));
    return chunksWithParents.map((chunk) => ({
        ...chunk,
        previousSiblingChunkId: siblingIdsByChunkId[chunk.id]?.previousSiblingChunkId,
        nextSiblingChunkId: siblingIdsByChunkId[chunk.id]?.nextSiblingChunkId,
    }));
}
function siblingContextId(chunk, symbols) {
    const symbol = symbols[chunk.symbolIds.at(-1) ?? ""];
    return `${chunk.filePath}:${chunk.parentChunkId ?? "root"}:${symbol?.id ?? "no-symbol"}`;
}
function containsRange(parentStart, parentEnd, childStart, childEnd) {
    return parentStart <= childStart && childEnd <= parentEnd;
}
function strictlyContainsRange(parentStart, parentEnd, childStart, childEnd) {
    return (containsRange(parentStart, parentEnd, childStart, childEnd) && (parentStart < childStart || childEnd < parentEnd));
}
function rangeSize(chunk) {
    return chunk.range.byteEnd - chunk.range.byteStart;
}
export { linkChunkTopology, linkSymbolsToChunks };
