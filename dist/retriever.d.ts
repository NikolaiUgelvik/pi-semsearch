import type { CastIndex, HybridRetrievalOptions, HydratedChunkSet, LexicalChunkCandidate, RerankOptions, SearchInput, SearchOutput, VectorCandidateSearchResult } from "./types.js";
export interface RetrievalIndexStore {
    readMetadata(): Promise<CastIndex["metadata"]>;
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<VectorCandidateSearchResult>;
    searchLexicalCandidates?(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>;
    hydrateChunks(chunkIds: string[]): Promise<HydratedChunkSet>;
}
export interface RetrieveFromStoreInput {
    input: SearchInput;
    options: {
        topK: number;
        maxContextChars: number;
        hyde: {
            enabled: boolean;
            threshold: number;
        };
        hybrid?: HybridRetrievalOptions;
        rerank?: RerankOptions;
        maxVectorCandidates?: number;
        maxRerankCandidates?: number;
    };
    embed(text: string): Promise<number[]>;
    generateHyde(query: string): Promise<string>;
    rerank?(query: string, documents: string[]): Promise<Array<{
        index: number;
        score: number;
    }>>;
    readSource(filePath: string): Promise<string>;
    indexStore: RetrievalIndexStore;
}
export declare function retrieveFromStore(input: RetrieveFromStoreInput): Promise<SearchOutput>;
