export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export declare function createOpenAIClient(options?: {
    fetch?: FetchLike;
}): {
    embed: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        dimensions?: number;
        input: string;
    }) => Promise<number[]>;
    embedBatch: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        dimensions?: number;
        input: string[];
    }) => Promise<number[][]>;
    generateHyde: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        query: string;
    }) => Promise<string>;
    rerank: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        query: string;
        documents: string[];
    }) => Promise<{
        index: number;
        score: number;
    }[]>;
};
