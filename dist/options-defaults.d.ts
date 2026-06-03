import type { ChunkingOptions } from "./types.js";
declare const DEFAULT_HYDE_THRESHOLD = 0.35;
declare const DEFAULT_RERANK_CANDIDATE_MULTIPLIER = 4;
declare const DEFAULT_HYBRID_OPTIONS: {
    enabled: boolean;
    rrfK: number;
    vectorCandidateMultiplier: number;
    bm25CandidateMultiplier: number;
    vectorWeight: number;
    bm25Weight: number;
};
declare const DEFAULT_MAX_VECTOR_CANDIDATES = 512;
declare const DEFAULT_MAX_RERANK_CANDIDATES = 64;
declare const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions;
declare const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
declare const DEFAULT_EMBEDDING_CONCURRENCY = 1;
declare const DEFAULT_PROVIDER_TIMEOUT_MS = 30000;
declare const MAX_EMBEDDING_BATCH_SIZE = 2048;
declare const MAX_EMBEDDING_CONCURRENCY = 8;
declare const DEFAULT_RESULT_OPTIONS: {
    maxChunkNonWhitespaceChars: number;
    maxFileBytes: number;
    maxContextChars: number;
    topK: number;
    includeGlobs: string[];
    excludeGlobs: string[];
};
export { DEFAULT_CHUNKING_OPTIONS, DEFAULT_EMBEDDING_BATCH_SIZE, DEFAULT_EMBEDDING_CONCURRENCY, DEFAULT_HYBRID_OPTIONS, DEFAULT_HYDE_THRESHOLD, DEFAULT_MAX_RERANK_CANDIDATES, DEFAULT_MAX_VECTOR_CANDIDATES, DEFAULT_PROVIDER_TIMEOUT_MS, DEFAULT_RERANK_CANDIDATE_MULTIPLIER, DEFAULT_RESULT_OPTIONS, MAX_EMBEDDING_BATCH_SIZE, MAX_EMBEDDING_CONCURRENCY, };
