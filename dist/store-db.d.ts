import BetterSqlite3 from "better-sqlite3";
type SqliteParameters = unknown[];
declare class SqliteDatabase {
    private readonly db;
    constructor(db: BetterSqlite3.Database);
    query(sql: string): {
        get: (...params: SqliteParameters) => unknown;
        all: (...params: SqliteParameters) => unknown[];
        run: (...params: SqliteParameters) => BetterSqlite3.RunResult;
    };
    run(sql: string, params?: SqliteParameters): BetterSqlite3.RunResult;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
}
declare function openSqliteIndex(file: string, embeddingDimensions?: number): Promise<SqliteDatabase>;
export type { SqliteParameters };
export { openSqliteIndex, SqliteDatabase };
