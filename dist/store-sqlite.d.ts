import type { StoreFileResult as FileResult, StoreHydrateChunksOptions as HydrateChunksOptions } from "./store-types.js";
import type { CastIndex } from "./types.js";
declare function createSqliteIndexStore(cacheDir: string, cacheKey: string, embeddingDimensions?: number): {
    read(): Promise<CastIndex>;
    write(index: CastIndex): Promise<void>;
    readMetadata(): Promise<import("./types.js").IndexMetadata>;
    hydrateChunks(chunkIds: string[], options?: HydrateChunksOptions): Promise<import("./types.js").HydratedChunkSet>;
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<import("./types.js").VectorCandidateSearchResult>;
    searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<import("./types.js").LexicalChunkCandidate[]>;
    beginIndexRun(input: {
        configHash: string;
        metadata: CastIndex["metadata"];
    }): Promise<{
        runId: string;
    }>;
    getCompletedFile(runId: string, filePath: string, fingerprint: string): Promise<FileResult | undefined>;
    writeFileResult(runId: string, fileResult: FileResult): Promise<void>;
    writeFileResults(runId: string, fileResults: FileResult[]): Promise<void>;
    activateRun(runId: string, index: CastIndex): Promise<void>;
};
export { createSqliteIndexStore };
