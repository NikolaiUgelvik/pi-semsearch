import { createEmptySqliteIndex } from "./store-index.js";
import { hydrateStoredChunkRecord, readActiveRunId, readChunks, readFiles, readFilesByPaths, readLexical, readRunMetadata, readStoredChunksByIds, readSymbols, readSymbolsByIds, readVectors, readVectorsForChunkIds, } from "./store-read-rows.js";
import { CorruptIndexError } from "./store-types.js";
import { isCastIndex } from "./store-validate.js";
function readSqliteIndex(db, cacheKey, embeddingDimensions) {
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions);
    }
    try {
        return readActiveSqliteIndex(db, activeRunId, cacheKey, embeddingDimensions);
    }
    catch (error) {
        if (!(error instanceof CorruptIndexError)) {
            throw error;
        }
        return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
}
function readActiveSqliteIndex(db, activeRunId, cacheKey, embeddingDimensions) {
    const metadata = readRunMetadata(db, activeRunId);
    if (!metadata) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
    const index = buildSqliteIndex(db, activeRunId, metadata);
    return isCastIndex(index)
        ? index
        : createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
}
function buildSqliteIndex(db, activeRunId, metadata) {
    const files = readFiles(db, activeRunId);
    const diagnostics = [...metadata.diagnostics];
    const diagnosticDetails = [...(metadata.diagnosticDetails ?? [])];
    const index = {
        metadata: { ...metadata, diagnostics, diagnosticDetails },
        files,
        chunks: readChunks(db, activeRunId, readVectors(db, activeRunId), {
            worktree: metadata.worktree,
            files,
            diagnostics,
            diagnosticDetails,
        }),
        symbols: readSymbols(db, activeRunId),
    };
    const lexical = readLexical(db, activeRunId);
    if (lexical) {
        index.lexical = lexical;
    }
    return index;
}
function readSqliteMetadata(db, cacheKey, embeddingDimensions) {
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions).metadata;
    }
    try {
        return (readRunMetadata(db, activeRunId) ??
            createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata);
    }
    catch (error) {
        if (!(error instanceof CorruptIndexError)) {
            throw error;
        }
        return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata;
    }
}
function hydrateSqliteChunks(input) {
    const { db, cacheKey, embeddingDimensions, chunkIds, options } = input;
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return emptyHydratedChunkSet(cacheKey, embeddingDimensions);
    }
    const metadata = readSqliteMetadata(db, cacheKey, embeddingDimensions);
    if (!metadata) {
        return emptyHydratedChunkSet(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
    if (chunkIds.length === 0) {
        const hydrated = { metadata, files: {}, chunks: {}, symbols: {}, diagnostics: [] };
        if (options?.includeLexical) {
            const lexical = readLexical(db, activeRunId);
            if (lexical) {
                hydrated.lexical = lexical;
            }
        }
        return hydrated;
    }
    return hydrateActiveSqliteChunks({ db, activeRunId, metadata, chunkIds, options });
}
function hydrateActiveSqliteChunks(input) {
    const { db, activeRunId, metadata, chunkIds, options } = input;
    const ids = chunkIdsWithTopology(db, activeRunId, chunkIds);
    const orderedStoredChunks = orderedStoredChunksByIds(db, activeRunId, ids);
    const files = readFilesByPaths(db, activeRunId, filePathsForChunks(orderedStoredChunks));
    const diagnostics = [...metadata.diagnostics];
    const diagnosticDetails = [...(metadata.diagnosticDetails ?? [])];
    const sourceContext = { worktree: metadata.worktree, files, diagnostics, diagnosticDetails };
    const chunks = hydrateStoredChunks({ db, activeRunId, ids, orderedStoredChunks, sourceContext });
    const hydrated = hydratedChunkSet({ db, activeRunId, metadata, files, chunks, diagnostics, diagnosticDetails });
    if (options?.includeLexical) {
        const lexical = readLexical(db, activeRunId);
        if (lexical) {
            hydrated.lexical = lexical;
        }
    }
    return hydrated;
}
function orderedStoredChunksByIds(db, activeRunId, ids) {
    const storedChunks = readStoredChunksByIds(db, activeRunId, ids);
    return ids.flatMap((chunkId) => {
        const chunk = storedChunks.get(chunkId);
        return chunk ? [chunk] : [];
    });
}
function filePathsForChunks(chunks) {
    return [...new Set(chunks.map((chunk) => chunk.filePath))];
}
function hydrateStoredChunks(input) {
    const sourceCache = new Map();
    const vectors = readVectorsForChunkIds(input.db, input.activeRunId, input.ids);
    const chunks = {};
    for (const storedChunk of input.orderedStoredChunks) {
        const chunk = hydrateStoredChunkRecord({
            storedRecord: storedChunk,
            vectors,
            sourceContext: input.sourceContext,
            sourceCache,
        });
        chunks[chunk.id] = chunk;
    }
    return chunks;
}
function hydratedChunkSet(input) {
    const hydrated = {
        metadata: { ...input.metadata, diagnostics: input.diagnostics, diagnosticDetails: input.diagnosticDetails },
        files: input.files,
        chunks: input.chunks,
        symbols: readSymbolsByIds(input.db, input.activeRunId, symbolIdsForChunks(input.chunks)),
        diagnostics: input.diagnostics,
    };
    if (input.diagnosticDetails.length > 0) {
        hydrated.diagnosticDetails = input.diagnosticDetails;
    }
    return hydrated;
}
function symbolIdsForChunks(chunks) {
    return [...new Set(Object.values(chunks).flatMap((chunk) => chunk.symbolIds))];
}
function emptyHydratedChunkSet(cacheKey, embeddingDimensions, diagnostics) {
    return {
        metadata: createEmptySqliteIndex(cacheKey, embeddingDimensions, diagnostics).metadata,
        files: {},
        chunks: {},
        symbols: {},
        diagnostics: diagnostics ?? [],
    };
}
function chunkIdsWithTopology(db, runId, chunkIds) {
    const selected = readStoredChunksByIds(db, runId, [...new Set(chunkIds)]);
    const ids = selectedChunkIds(chunkIds, selected);
    appendRelatedChunkIds(ids, selected);
    return ids;
}
function selectedChunkIds(chunkIds, selected) {
    const ids = [];
    const seen = new Set();
    for (const chunkId of chunkIds) {
        if (seen.has(chunkId) || !selected.has(chunkId)) {
            continue;
        }
        ids.push(chunkId);
        seen.add(chunkId);
    }
    return ids;
}
function appendRelatedChunkIds(ids, selected) {
    const seen = new Set(ids);
    for (const chunkId of ids.slice()) {
        const chunk = selected.get(chunkId);
        if (!chunk) {
            continue;
        }
        for (const relatedId of relatedChunkIds(chunk)) {
            if (relatedId && !seen.has(relatedId)) {
                ids.push(relatedId);
                seen.add(relatedId);
            }
        }
    }
}
function relatedChunkIds(chunk) {
    return [chunk.parentChunkId, ...chunk.childChunkIds, chunk.previousSiblingChunkId, chunk.nextSiblingChunkId];
}
export { hydrateSqliteChunks, readSqliteIndex, readSqliteMetadata };
