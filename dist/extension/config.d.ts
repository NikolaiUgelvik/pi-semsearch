declare function loadPiSemsearchOptions(worktree: string): Promise<{
    cacheDir: string;
    diagnostics: string[];
    maxChunkNonWhitespaceChars: number;
    maxFileBytes: number;
    maxContextChars: number;
    topK: number;
    includeGlobs: string[];
    excludeGlobs: string[];
    embedding: {
        baseURL: string;
        apiKey: string | undefined;
        model: string;
        dimensions: number | undefined;
        batchSize: number;
        concurrency: number;
        timeoutMs: number;
    } | undefined;
    hyde: import("../shared/types.js").HydeOptions;
    rerank: {
        baseURL: string;
        apiKey: string | undefined;
        model: string;
        candidateMultiplier: number;
        timeoutMs: number;
    } | undefined;
    retrieval: {
        hybrid: {
            enabled: boolean;
            rrfK: number;
            vectorCandidateMultiplier: number;
            bm25CandidateMultiplier: number;
            vectorWeight: number;
            bm25Weight: number;
        };
        maxVectorCandidates: number;
        maxRerankCandidates: number;
    };
    chunking: import("../shared/types.js").ChunkingOptions;
}>;
export { loadPiSemsearchOptions };
