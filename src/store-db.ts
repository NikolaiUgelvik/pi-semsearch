import { mkdir } from "node:fs/promises"
import path from "node:path"
import BetterSqlite3 from "better-sqlite3"
import { load as loadSqliteVec } from "sqlite-vec"
import { initializeSchema } from "./store-schema.js"

type SqliteParameters = unknown[]

class SqliteDatabase {
  private readonly db: BetterSqlite3.Database

  constructor(db: BetterSqlite3.Database) {
    this.db = db
  }

  query(sql: string) {
    const statement = this.db.prepare(sql)
    return {
      get: (...params: SqliteParameters) => statement.get(...normalizeSqliteParams(params)),
      all: (...params: SqliteParameters) => statement.all(...normalizeSqliteParams(params)),
      run: (...params: SqliteParameters) => statement.run(...normalizeSqliteParams(params)),
    }
  }

  run(sql: string, params: SqliteParameters = []) {
    return this.db.prepare(sql).run(...params)
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.db.transaction(fn) as unknown as T
  }

  close() {
    this.db.close()
  }
}

function normalizeSqliteParams(params: SqliteParameters) {
  return params.length === 1 && Array.isArray(params[0]) ? (params[0] as SqliteParameters) : params
}
async function openSqliteIndex(file: string, embeddingDimensions?: number) {
  await mkdir(path.dirname(file), { recursive: true })
  const rawDb = new BetterSqlite3(file)
  const db = new SqliteDatabase(rawDb)
  try {
    loadSqliteVec(rawDb)
    initializeSchema(db, embeddingDimensions)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export type { SqliteParameters }
export { openSqliteIndex, SqliteDatabase }
