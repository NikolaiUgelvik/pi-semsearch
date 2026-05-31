function linkSymbolsToChunks(chunks, symbols) {
    const symbolsByFile = groupByFile(Object.values(symbols));
    return chunks.map((chunk) => ({
        ...chunk,
        symbolIds: (symbolsByFile[chunk.filePath] ?? [])
            .filter((symbol) => containsRange(symbol.range.byteStart, symbol.range.byteEnd, chunk.range.byteStart, chunk.range.byteEnd))
            .sort((left, right) => left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd)
            .map((symbol) => symbol.id),
    }));
}
function linkChunkTopology(chunks, symbols) {
    const relations = chunkRelations(chunks);
    const chunksWithParents = chunks.map((chunk) => ({
        ...chunk,
        parentChunkId: relations[chunk.id]?.parentChunkId,
        childChunkIds: relations[chunk.id]?.childChunkIds ?? [],
    }));
    return attachSiblingLinks(chunksWithParents, symbols);
}
function chunkRelations(chunks) {
    const relations = {};
    for (const chunk of chunks) {
        relations[chunk.id] = { childChunkIds: [] };
    }
    for (const fileChunks of Object.values(groupByFile(chunks))) {
        const stack = [];
        for (const chunk of [...fileChunks].sort(compareForTopology)) {
            while (stack.length > 0 && !containsChunk(stack.at(-1), chunk)) {
                stack.pop();
            }
            const parent = stack.at(-1);
            if (parent) {
                relations[chunk.id].parentChunkId = parent.id;
                relations[parent.id].childChunkIds.push(chunk.id);
            }
            stack.push(chunk);
        }
    }
    return relations;
}
function containsChunk(parent, child) {
    return strictlyContainsRange(parent.range.byteStart, parent.range.byteEnd, child.range.byteStart, child.range.byteEnd);
}
function compareForTopology(left, right) {
    return left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd;
}
function groupByFile(items) {
    const groups = {};
    for (const item of items) {
        groups[item.filePath] = [...(groups[item.filePath] ?? []), item];
    }
    return groups;
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
export { linkChunkTopology, linkSymbolsToChunks };
