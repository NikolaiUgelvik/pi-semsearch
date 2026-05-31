import type { ChunkingOptions, HydeOptions } from "./types.js";
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
    } | undefined;
    hyde: HydeOptions;
    rerank: {
        baseURL: string;
        apiKey: string | undefined;
        model: string;
        candidateMultiplier: number;
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
    };
    chunking: ChunkingOptions;
};
