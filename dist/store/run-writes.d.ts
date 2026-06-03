import type { CastIndex } from "../shared/types.js";
import type { SqliteDatabase as Database } from "./db.js";
import type { StoreFileResult as FileResult } from "./types.js";
declare function writeSqliteIndex(db: Database, index: CastIndex): void;
declare function beginSqliteIndexRun(db: Database, configHash: string, metadata: CastIndex["metadata"]): {
    runId: string;
};
declare function getCompletedSqliteFile(db: Database, runId: string, filePath: string, fingerprint: string): FileResult | undefined;
declare function writeSqliteFileResult(db: Database, runId: string, fileResult: FileResult): void;
declare function writeSqliteFileResults(db: Database, runId: string, fileResults: FileResult[]): void;
declare function activateSqliteRun(db: Database, runId: string, index: CastIndex): void;
export { activateSqliteRun, beginSqliteIndexRun, getCompletedSqliteFile, writeSqliteFileResult, writeSqliteFileResults, writeSqliteIndex, };
