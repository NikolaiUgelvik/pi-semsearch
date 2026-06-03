import BetterSqlite3 from "better-sqlite3"

export type SqliteParameter = string | number | bigint | null | Buffer

export class Database {
  private readonly db: BetterSqlite3.Database

  constructor(file: string) {
    this.db = new BetterSqlite3(file)
  }

  query(sql: string) {
    const statement = this.db.prepare(sql)
    return {
      get: (...params: SqliteParameter[]) => statement.get(...params),
      all: (...params: SqliteParameter[]) => statement.all(...params),
    }
  }

  run(sql: string, params: SqliteParameter[] = []) {
    return this.db.prepare(sql).run(...params)
  }

  close() {
    this.db.close()
  }

  raw() {
    return this.db
  }
}
