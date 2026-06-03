import type { SqliteDatabase as Database } from "./store-db.js"

const SQLITE_SCHEMA_VERSION = 4

function initializeSchema(db: Database, embeddingDimensions?: number) {
  db.run("create table if not exists meta (key text primary key, value text not null)")
  db.run("insert or replace into meta (key, value) values ('schema_version', ?)", [String(SQLITE_SCHEMA_VERSION)])
  db.run(
    "create table if not exists runs (id text primary key, status text not null, config_hash text not null, started_at integer not null, completed_at integer, metadata_json text not null)",
  )
  db.run(
    "create table if not exists files (path text primary key, language text not null, fingerprint text not null, diagnostics_json text not null)",
  )
  addColumnIfMissing(db, "files", "size_bytes", "integer")
  addColumnIfMissing(db, "files", "mtime_ms", "real")
  addColumnIfMissing(db, "files", "ctime_ms", "real")
  db.run(
    "create table if not exists file_runs (run_id text not null, path text not null, chunk_ids_json text not null, primary key (run_id, path))",
  )
  addColumnIfMissing(db, "file_runs", "language", "text")
  addColumnIfMissing(db, "file_runs", "fingerprint", "text")
  addColumnIfMissing(db, "file_runs", "size_bytes", "integer")
  addColumnIfMissing(db, "file_runs", "mtime_ms", "real")
  addColumnIfMissing(db, "file_runs", "ctime_ms", "real")
  addColumnIfMissing(db, "file_runs", "diagnostics_json", "text")
  db.run(
    "create table if not exists chunks (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))",
  )
  db.run("create index if not exists chunks_run_file_path_idx on chunks (run_id, file_path)")
  db.run(
    "create table if not exists symbols (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))",
  )
  db.run("create index if not exists symbols_run_file_path_idx on symbols (run_id, file_path)")
  db.run("create table if not exists lexical (run_id text primary key, metadata_json text not null)")
  db.run(
    "create table if not exists chunk_rowids (run_id text not null, chunk_id text not null, rowid integer not null, primary key (run_id, chunk_id))",
  )
  db.run("create index if not exists chunk_rowids_run_rowid_idx on chunk_rowids (run_id, rowid)")
  if (embeddingDimensions !== undefined) {
    db.run(`create virtual table if not exists chunk_vectors using vec0(embedding float[${embeddingDimensions}])`)
  }
  db.run("create virtual table if not exists chunk_fts using fts5(run_id unindexed, id unindexed, content)")
}

function tableExists(db: Database, table: string) {
  return Boolean(db.query("select name from sqlite_master where type = 'table' and name = ?").get(table))
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string) {
  const columns = db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((existing) => existing.name === column)) {
    db.run(`alter table ${table} add column ${column} ${definition}`)
  }
}

export { initializeSchema, tableExists }
