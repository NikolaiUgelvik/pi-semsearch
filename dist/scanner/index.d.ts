import type { CastIndex } from "../shared/types.js";
import type { CreateIndexerInput, ScannerFileResult, ScannerStore } from "./types.js";
export interface FileResult extends ScannerFileResult {
}
export interface Store extends Omit<ScannerStore, "getCompletedFile" | "writeFileResult" | "writeFileResults"> {
    getCompletedFile?(runId: string, filePath: string, fingerprint: string): Promise<FileResult | undefined>;
    writeFileResult?(runId: string, fileResult: FileResult): Promise<void>;
    writeFileResults?(runId: string, fileResults: FileResult[]): Promise<void>;
}
export interface PublicCreateIndexerInput extends Omit<CreateIndexerInput, "store"> {
    store: Store;
}
export declare function createIndexer(input: PublicCreateIndexerInput): {
    refresh(signal?: AbortSignal): Promise<CastIndex>;
    refreshFile(filePath: string, signal?: AbortSignal): Promise<CastIndex>;
};
