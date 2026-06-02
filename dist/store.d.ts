import type { CastIndex, ChunkingOptions, ChunkRecord, FileRecord, HydratedChunkSet, LexicalChunkCandidate, SymbolRecord, VectorCandidateSearchResult } from "./types.js";
interface FileResult {
    file: FileRecord;
    chunks: Record<string, ChunkRecord>;
    symbols: Record<string, SymbolRecord>;
}
interface HydrateChunksOptions {
    includeLexical?: boolean;
}
export declare function createEmptyIndex(input: {
    projectId: string;
    worktree: string;
    cacheKey: string;
    maxChunkNonWhitespaceChars: number;
    chunking?: ChunkingOptions;
    diagnostics?: string[];
}): CastIndex;
export declare function createIndexStore(input: {
    cacheDir: string;
    cacheKey: string;
    embeddingDimensions?: number;
}): {
    read(): Promise<CastIndex>;
    write(index: CastIndex): Promise<void>;
    readMetadata(): Promise<import("./types.js").IndexMetadata>;
    hydrateChunks(chunkIds: string[], options?: HydrateChunksOptions): Promise<HydratedChunkSet>;
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<VectorCandidateSearchResult>;
    searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>;
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
export declare function cosineSimilarity(left: number[], right: number[]): number;
export declare function searchVectors(query: number[], vectors: Array<{
    id: string;
    vector: number[];
}>, topK: number): {
    id: string;
    score: number;
}[];
export {};
