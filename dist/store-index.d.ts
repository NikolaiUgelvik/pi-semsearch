import type { CastIndex, ChunkingOptions } from "./types.js";
declare const INDEX_SCHEMA_VERSION = 1;
declare function buildEmptyIndex(input: {
    projectId: string;
    worktree: string;
    cacheKey: string;
    maxChunkNonWhitespaceChars: number;
    chunking?: ChunkingOptions;
    diagnostics?: string[];
}): CastIndex;
declare function createEmptySqliteIndex(cacheKey: string, embeddingDimensions?: number, diagnostics?: string[]): CastIndex;
export { buildEmptyIndex, createEmptySqliteIndex, INDEX_SCHEMA_VERSION };
