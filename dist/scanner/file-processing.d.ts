import type { CastIndex } from "../shared/types.js";
import type { CreateIndexerInput, EmbeddingBatcher, FileResultWriter, IndexRunStore, RefreshState } from "./types.js";
interface ScannedFileInput {
    input: CreateIndexerInput;
    index: CastIndex;
    state: RefreshState;
    relativePath: string;
    runStore: IndexRunStore | undefined;
    run: () => {
        runId: string;
    } | undefined;
    ensureRun: () => Promise<{
        runId: string;
    } | undefined>;
    embeddingBatcher: EmbeddingBatcher;
    fileResultWriter: FileResultWriter;
    signal?: AbortSignal;
}
declare function processScannedFile(input: ScannedFileInput): Promise<boolean>;
declare function flushQueuedReusedFileResults(input: {
    state: RefreshState;
    runStore: IndexRunStore | undefined;
    run: () => {
        runId: string;
    } | undefined;
    ensureRun: () => Promise<{
        runId: string;
    } | undefined>;
    fileResultWriter: FileResultWriter;
}): Promise<void>;
export type { ScannedFileInput };
export { flushQueuedReusedFileResults, processScannedFile };
