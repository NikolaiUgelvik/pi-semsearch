export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number, signal?: AbortSignal | null) => Promise<void>;
export type RandomLike = () => number;
interface SignalInput {
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare function createOpenAIClient(options?: {
    fetch?: FetchLike;
    sleep?: SleepLike;
    random?: RandomLike;
}): {
    embed: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        dimensions?: number;
        input: string;
    } & SignalInput) => Promise<number[]>;
    embedBatch: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        dimensions?: number;
        input: string[];
    } & SignalInput) => Promise<number[][]>;
    generateHyde: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        query: string;
    } & SignalInput) => Promise<string>;
    rerank: (input: {
        baseURL: string;
        apiKey?: string;
        model: string;
        query: string;
        documents: string[];
    } & SignalInput) => Promise<{
        index: number;
        score: number;
    }[]>;
};
export {};
