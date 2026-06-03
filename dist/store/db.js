import { mkdir } from "node:fs/promises";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { initializeSchema } from "./schema.js";
class SqliteDatabase {
    db;
    constructor(db) {
        this.db = db;
    }
    query(sql) {
        const statement = this.db.prepare(sql);
        return {
            get: (...params) => statement.get(...normalizeSqliteParams(params)),
            all: (...params) => statement.all(...normalizeSqliteParams(params)),
            run: (...params) => statement.run(...normalizeSqliteParams(params)),
        };
    }
    run(sql, params = []) {
        return this.db.prepare(sql).run(...params);
    }
    transaction(fn) {
        return this.db.transaction(fn);
    }
    close() {
        this.db.close();
    }
}
function normalizeSqliteParams(params) {
    return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}
async function openSqliteIndex(file, embeddingDimensions) {
    await mkdir(path.dirname(file), { recursive: true });
    const rawDb = new BetterSqlite3(file);
    const db = new SqliteDatabase(rawDb);
    try {
        loadSqliteVec(rawDb);
        initializeSchema(db, embeddingDimensions);
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
export { openSqliteIndex, SqliteDatabase };
