import { complete } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FetchLike } from "../embeddings/openai.js";
import type { parseOptions } from "../options/index.js";
import { getChunkById } from "../retriever/chunk-lookup.js";
import { retrieveFromStore } from "../retriever/index.js";
import { createIndexer } from "../scanner/index.js";
import type { SearchOutput } from "../shared/types.js";
import { createIndexStore } from "../store/index.js";
import type { ToolOutputLimits } from "./output.js";
interface RuntimeDependencies {
    fetch?: FetchLike;
    createStore?: typeof createIndexStore;
    createIndexer?: typeof createIndexer;
    retrieve?: typeof retrieveFromStore;
    complete?: typeof complete;
}
declare class SemsearchRuntime {
    private readonly client;
    private readonly lifecycle;
    private readonly worktree;
    private readonly options;
    private readonly dependencies;
    private readonly store;
    private storeError;
    private refresh;
    private forcedRefresh;
    private refreshTail;
    private readonly pendingWrites;
    constructor(input: {
        worktree: string;
        options: ReturnType<typeof parseOptions>;
        dependencies?: RuntimeDependencies;
    });
    start(): Promise<void>;
    dispose(): void;
    queueRefresh(refreshInput?: {
        background?: boolean;
        forced?: boolean;
        filePath?: string;
    }): Promise<unknown>;
    semanticSearchOutput(args: Parameters<typeof retrieveFromStore>[0]["input"], signal?: AbortSignal, ctx?: Pick<ExtensionContext, "model" | "modelRegistry">): Promise<SearchOutput>;
    lookupChunk(args: Parameters<typeof getChunkById>[0]["input"]): Promise<{
        title: string;
        output: string;
        metadata: {
            configured: boolean;
            available: boolean;
        };
    } | {
        title: string;
        output: string;
        metadata: {
            configured: boolean;
            found?: undefined;
        };
    } | {
        title: string;
        output: string;
        metadata: {
            found: boolean;
            configured?: undefined;
        };
    }>;
    semanticSearchUnavailable(): {
        title: string;
        output: string;
        metadata: {
            configured: boolean;
            available: boolean;
        };
    } | {
        title: string;
        output: string;
        metadata: {
            configured: boolean;
        };
    } | undefined;
    searchToolResult(query: string, output: SearchOutput, limits?: ToolOutputLimits): {
        title: string;
        output: string;
        metadata: {
            hydeUsed: boolean;
            rerankUsed: boolean;
            resultCount: number;
            minFinalScore: number;
            filteredCount: number;
        };
    };
    trackPendingWrite(toolCallId: string, filePath: string): void;
    completePendingWrite(toolCallId: string, filePath: string, succeeded: boolean): Promise<unknown> | undefined;
    resolveUnseenPendingWrite(toolCallId: string): void;
    refreshAfterWrite(filePath: string): Promise<unknown> | undefined;
    currentRefresh(): Promise<unknown> | undefined;
    private waitForPendingWriteRefreshes;
    private clearRefresh;
    private recordStoreUnavailable;
    private readIndex;
    private readChunkLookupIndex;
    private wrapStoreOperation;
    private wrapIndexingStore;
    private retrievalIndexStore;
    private generateHydeText;
    private generatePiHydeText;
}
export type { RuntimeDependencies };
export { SemsearchRuntime };
