import { type SyntaxNode } from "./cast.js";
import type { CastIndex, ChunkingOptions, ChunkRecord, FileRecord, SymbolRecord } from "./types.js";
export type FileResult = {
    file: FileRecord;
    chunks: Record<string, ChunkRecord>;
    symbols: Record<string, SymbolRecord>;
};
export type Store = {
    read(): Promise<CastIndex>;
    write(index: CastIndex): Promise<void>;
    beginIndexRun?(input: {
        configHash: string;
        metadata: CastIndex["metadata"];
    }): Promise<{
        runId: string;
    }>;
    getCompletedFile?(runId: string, filePath: string, fingerprint: string): Promise<FileResult | undefined>;
    writeFileResult?(runId: string, fileResult: FileResult): Promise<void>;
    writeFileResults?(runId: string, fileResults: FileResult[]): Promise<void>;
    activateRun?(runId: string, index: CastIndex): Promise<void>;
};
export declare function createIndexer(input: {
    worktree: string;
    options: {
        maxChunkNonWhitespaceChars: number;
        maxFileBytes: number;
        includeGlobs: string[];
        excludeGlobs: string[];
        topK: number;
        maxContextChars: number;
        chunking: ChunkingOptions;
        embeddingBatchSize?: number;
    };
    store: Store;
    parse(filePath: string, source: string): Promise<{
        language: string;
        root?: SyntaxNode;
    }>;
    embed(text: string): Promise<number[]>;
    embedBatch?(texts: string[]): Promise<number[][]>;
}): {
    refresh(): Promise<CastIndex>;
};
