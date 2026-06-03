const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_CHUNKING_OPTIONS = {
    overlap: 0,
    expansion: false,
    minSemanticNonWhitespaceChars: 8,
};
function buildEmptyIndex(input) {
    return {
        metadata: {
            schemaVersion: INDEX_SCHEMA_VERSION,
            projectId: input.projectId,
            worktree: input.worktree,
            cacheKey: input.cacheKey,
            maxChunkNonWhitespaceChars: input.maxChunkNonWhitespaceChars,
            chunking: input.chunking ?? DEFAULT_CHUNKING_OPTIONS,
            updatedAt: Date.now(),
            status: "empty",
            diagnostics: input.diagnostics ?? [],
        },
        files: {},
        chunks: {},
        symbols: {},
    };
}
function createEmptySqliteIndex(cacheKey, embeddingDimensions, diagnostics) {
    const index = buildEmptyIndex({
        projectId: cacheKey,
        worktree: "",
        cacheKey,
        maxChunkNonWhitespaceChars: 2000,
        diagnostics,
    });
    if (embeddingDimensions !== undefined) {
        index.metadata.embeddingDimensions = embeddingDimensions;
    }
    return index;
}
export { buildEmptyIndex, createEmptySqliteIndex, INDEX_SCHEMA_VERSION };
