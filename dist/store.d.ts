import type { ChunkingOptions } from "./types.js";
declare function createEmptyIndex(input: {
    projectId: string;
    worktree: string;
    cacheKey: string;
    maxChunkNonWhitespaceChars: number;
    chunking?: ChunkingOptions;
    diagnostics?: string[];
}): import("./types.js").CastIndex;
declare function createIndexStore(input: {
    cacheDir: string;
    cacheKey: string;
    embeddingDimensions?: number;
}): {
    read(): Promise<import("./types.js").CastIndex>;
    write(index: import("./types.js").CastIndex): Promise<void>;
    readMetadata(): Promise<import("./types.js").IndexMetadata>;
    hydrateChunks(chunkIds: string[], options?: import("./store-types.js").StoreHydrateChunksOptions): Promise<import("./types.js").HydratedChunkSet>;
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<import("./types.js").VectorCandidateSearchResult>;
    searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<import("./types.js").LexicalChunkCandidate[]>;
    beginIndexRun(input: {
        configHash: string;
        metadata: import("./types.js").CastIndex["metadata"];
    }): Promise<{
        runId: string;
    }>;
    getCompletedFile(runId: string, filePath: string, fingerprint: string): Promise<import("./store-types.js").StoreFileResult | undefined>;
    writeFileResult(runId: string, fileResult: import("./store-types.js").StoreFileResult): Promise<void>;
    writeFileResults(runId: string, fileResults: import("./store-types.js").StoreFileResult[]): Promise<void>;
    activateRun(runId: string, index: import("./types.js").CastIndex): Promise<void>;
};
declare function cosineSimilarity(left: number[], right: number[]): number;
declare function searchVectors(query: number[], vectors: Array<{
    id: string;
    vector: number[];
}>, topK: number): {
    id: string;
    score: number;
}[];
export { cosineSimilarity, createEmptyIndex, createIndexStore, searchVectors };
