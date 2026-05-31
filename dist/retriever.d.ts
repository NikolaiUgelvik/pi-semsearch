import { type RankedResult } from "./lexical.js";
import type { CastIndex, HybridRetrievalOptions, RerankOptions, SearchInput, SearchOutput } from "./types.js";
export interface VectorCandidateSource {
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<RankedResult[]>;
}
export interface RetrieveInput {
    index: CastIndex;
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
    };
    embed(text: string): Promise<number[]>;
    generateHyde(query: string): Promise<string>;
    rerank?(query: string, documents: string[]): Promise<Array<{
        index: number;
        score: number;
    }>>;
    readSource(filePath: string): Promise<string>;
    indexStore?: VectorCandidateSource;
}
export declare function retrieve(input: RetrieveInput): Promise<SearchOutput>;
