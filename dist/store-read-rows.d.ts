import type { SqliteDatabase as Database } from "./store-db.js";
import type { SourceHydrationContext, SourceReadResult, StoredChunkRecord } from "./store-types.js";
import type { ChunkRecord, FileRecord, LexicalIndex, SymbolRecord } from "./types.js";
declare function hydrateStoredChunkRecord(input: {
    storedRecord: StoredChunkRecord;
    vectors: Map<string, number[]>;
    sourceContext?: SourceHydrationContext;
    sourceCache: Map<string, SourceReadResult>;
}): ChunkRecord;
declare function readActiveRunId(db: Database): string | undefined;
declare function readRunMetadata(db: Database, runId: string): import("./types.js").IndexMetadata | undefined;
declare function readFiles(db: Database, runId: string): Record<string, FileRecord>;
declare function readFilesByPaths(db: Database, runId: string, filePaths: string[]): Record<string, FileRecord>;
interface FileRow {
    path: string;
    language: string;
    fingerprint: string;
    sizeBytes: number | null;
    mtimeMs: number | null;
    ctimeMs: number | null;
    diagnosticsJson: string;
    chunkIdsJson: string;
}
declare function fileRecordFromRow(file: FileRow): FileRecord;
declare function readStoredChunksByIds(db: Database, runId: string, chunkIds: string[]): Map<string, StoredChunkRecord>;
declare function readVectors(db: Database, runId: string): Map<string, number[]>;
declare function readVectorsForChunkIds(db: Database, runId: string, chunkIds: string[]): Map<string, number[]>;
declare function readChunks(db: Database, runId: string, vectors: Map<string, number[]>, sourceContext?: SourceHydrationContext): Record<string, ChunkRecord>;
declare function readFileChunks(input: {
    db: Database;
    runId: string;
    file: FileRecord;
    vectors: Map<string, number[]>;
    sourceContext: SourceHydrationContext;
}): Record<string, ChunkRecord>;
declare function readSymbols(db: Database, runId: string): Record<string, SymbolRecord>;
declare function readSymbolsByIds(db: Database, runId: string, symbolIds: string[]): Record<string, SymbolRecord>;
declare function readSymbolsForFile(db: Database, runId: string, filePath: string): Record<string, SymbolRecord>;
declare function readLexical(db: Database, runId: string): LexicalIndex | undefined;
declare function parsePersistedJson<T = unknown>(json: string): T;
export type { FileRow };
export { fileRecordFromRow, hydrateStoredChunkRecord, parsePersistedJson, readActiveRunId, readChunks, readFileChunks, readFiles, readFilesByPaths, readLexical, readRunMetadata, readStoredChunksByIds, readSymbols, readSymbolsByIds, readSymbolsForFile, readVectors, readVectorsForChunkIds, };
