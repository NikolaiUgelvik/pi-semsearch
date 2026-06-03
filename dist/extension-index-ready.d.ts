import type { createOpenAIClient } from "./openai.js";
import type { parseOptions } from "./options.js";
import type { createIndexStore } from "./store.js";
import type { SearchOutput } from "./types.js";
declare const INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; results may be stale";
declare const INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; no searchable active index is available yet";
declare function queueInitialRefresh(input: {
    options: ReturnType<typeof parseOptions>;
    worktree: string;
    store: ReturnType<typeof createIndexStore> | undefined;
    queueRefresh: (input: {
        background?: boolean;
    }) => Promise<unknown>;
}): Promise<void>;
declare function ensureSearchIndexReady(shouldRefresh: boolean, queueRefresh: (input?: {
    forced?: boolean;
}) => Promise<unknown>, currentRefresh: () => Promise<unknown> | undefined, currentStoreError: () => string | undefined): Promise<{
    refreshInProgress: boolean;
}>;
declare function appendSearchDiagnostic(output: SearchOutput, diagnostic: string): SearchOutput;
declare function rerankDocuments(input: {
    query: string;
    documents: string[];
    rerank: ReturnType<typeof parseOptions>["rerank"];
    client: ReturnType<typeof createOpenAIClient>;
    signal?: AbortSignal;
}): Promise<{
    index: number;
    score: number;
}[]>;
export { appendSearchDiagnostic, ensureSearchIndexReady, INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC, INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC, queueInitialRefresh, rerankDocuments, };
