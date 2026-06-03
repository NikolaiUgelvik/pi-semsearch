import type { CastIndex } from "../shared/types.js";
import type { StoreFileResult as FileResult, StoreHydrateChunksOptions as HydrateChunksOptions } from "./types.js";
declare function createSqliteIndexStore(cacheDir: string, cacheKey: string, embeddingDimensions?: number): {
    read(): Promise<CastIndex>;
    write(index: CastIndex): Promise<void>;
    readMetadata(): Promise<import("../shared/types.js").IndexMetadata>;
    hydrateChunks(chunkIds: string[], options?: HydrateChunksOptions): Promise<import("../shared/types.js").HydratedChunkSet>;
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<import("../shared/types.js").VectorCandidateSearchResult>;
    searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<import("../shared/types.js").LexicalChunkCandidate[]>;
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
