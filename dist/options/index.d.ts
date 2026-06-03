import type { ChunkingOptions, HydeOptions } from "../shared/types.js";
export declare function parseOptions(input: unknown, env?: Record<string, string | undefined>): {
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
    hyde: HydeOptions;
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
    chunking: ChunkingOptions;
};
