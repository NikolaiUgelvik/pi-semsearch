import type { FileStatMetadata, LoadedFile } from "./scanner-types.js";
import type { DiagnosticRecord } from "./types.js";
declare function skipFileDiagnostic(relativePath: string, filePath: string, fileStat: FileStatMetadata | undefined, maxFileBytes: number): Promise<DiagnosticRecord | undefined>;
declare function loadTextFileForIndexing(filePath: string): Promise<LoadedFile>;
declare function statFileForIndexing(filePath: string): Promise<FileStatMetadata | undefined>;
declare function canReadFile(filePath: string): Promise<boolean>;
declare function statIsOlderThanIndex(fileStat: FileStatMetadata, updatedAt: number): boolean;
export { canReadFile, loadTextFileForIndexing, skipFileDiagnostic, statFileForIndexing, statIsOlderThanIndex };
