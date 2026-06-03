import type { ChunkRecord, SymbolRecord } from "../shared/types.js";
import type { CreateIndexerInput, EmbeddingBatcher, FileResultWriter, IndexRunStore } from "./types.js";
declare function createFileResultWriter(input: {
    runStore: IndexRunStore | undefined;
    run: () => {
        runId: string;
    } | undefined;
}): FileResultWriter;
declare function createEmbeddingBatcher(input: CreateIndexerInput, signal?: AbortSignal): EmbeddingBatcher;
declare function embedChunks(input: {
    input: CreateIndexerInput;
    relativePath: string;
    parsed: {
        language: string;
    };
    chunks: ChunkRecord[];
    symbolsById: Record<string, SymbolRecord>;
    fileDiagnostics: string[];
    embeddingBatcher: EmbeddingBatcher;
}): Promise<Record<string, ChunkRecord>>;
export { createEmbeddingBatcher, createFileResultWriter, embedChunks };
