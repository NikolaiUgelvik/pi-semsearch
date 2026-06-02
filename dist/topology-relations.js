function linkSymbolsToChunks(chunks, symbols) {
    const symbolsByFile = groupByFile(Object.values(symbols));
    const symbolIdsByChunkId = {};
    for (const [filePath, fileChunks] of Object.entries(groupByFile(chunks))) {
        Object.assign(symbolIdsByChunkId, symbolIdsForFileChunks(fileChunks, symbolsByFile[filePath] ?? []));
    }
    return chunks.map((chunk) => ({ ...chunk, symbolIds: symbolIdsByChunkId[chunk.id] ?? [] }));
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
        linkFileChunkRelations(fileChunks, relations);
    }
    return relations;
}
function symbolIdsForFileChunks(chunks, symbols) {
    const sortedSymbols = [...symbols].sort(compareSymbolsForChunk);
    const sortedChunks = [...chunks].sort((left, right) => left.range.byteStart - right.range.byteStart);
    const idsByChunkId = {};
    const activeSymbols = [];
    let symbolIndex = 0;
    for (const chunk of sortedChunks) {
        while (symbolIndex < sortedSymbols.length && sortedSymbols[symbolIndex].range.byteStart <= chunk.range.byteStart) {
            activeSymbols.push(sortedSymbols[symbolIndex]);
            symbolIndex += 1;
        }
        pruneInactiveSymbols(activeSymbols, chunk.range.byteStart);
        idsByChunkId[chunk.id] = activeSymbols.filter((symbol) => containsSymbol(symbol, chunk)).map((symbol) => symbol.id);
    }
    return idsByChunkId;
}
function pruneInactiveSymbols(activeSymbols, chunkStart) {
    for (let index = activeSymbols.length - 1; index >= 0; index -= 1) {
        if (activeSymbols[index].range.byteEnd < chunkStart) {
            activeSymbols.splice(index, 1);
        }
    }
}
function containsSymbol(symbol, chunk) {
    return containsRange(symbol.range.byteStart, symbol.range.byteEnd, chunk.range.byteStart, chunk.range.byteEnd);
}
function compareSymbolsForChunk(left, right) {
    return left.range.byteStart - right.range.byteStart || right.range.byteEnd - left.range.byteEnd;
}
function linkFileChunkRelations(fileChunks, relations) {
    const stack = [];
    for (const chunk of [...fileChunks].sort(compareForTopology)) {
        pruneNonParents(stack, chunk);
        recordParentRelation(chunk, stack.at(-1), relations);
        stack.push(chunk);
    }
}
function pruneNonParents(stack, chunk) {
    while (stack.length > 0 && !containsChunk(stack.at(-1), chunk)) {
        stack.pop();
    }
}
function recordParentRelation(chunk, parent, relations) {
    if (!parent) {
        return;
    }
    relations[chunk.id].parentChunkId = parent.id;
    relations[parent.id].childChunkIds.push(chunk.id);
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
        const group = groups[item.filePath] ?? [];
        group.push(item);
        groups[item.filePath] = group;
    }
    return groups;
}
function attachSiblingLinks(chunksWithParents, symbols) {
    const siblingGroups = {};
    for (const chunk of chunksWithParents) {
        const contextId = siblingContextId(chunk, symbols);
        const group = siblingGroups[contextId] ?? [];
        group.push(chunk);
        siblingGroups[contextId] = group;
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
