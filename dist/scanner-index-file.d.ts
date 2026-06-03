import type { CreateIndexerInput, EmbeddingBatcher, FileResultWriter, FileStatMetadata, IndexRunStore, RefreshState } from "./scanner-types.js";
declare function indexFile(input: {
    input: CreateIndexerInput;
    state: RefreshState;
    relativePath: string;
    absolutePath: string;
    currentFingerprint: string;
    fileStat: FileStatMetadata | undefined;
    text: string;
    runStore: IndexRunStore | undefined;
    run: () => {
        runId: string;
    } | undefined;
    embeddingBatcher: EmbeddingBatcher;
    fileResultWriter: FileResultWriter;
    signal?: AbortSignal;
}): Promise<void>;
export { indexFile };
