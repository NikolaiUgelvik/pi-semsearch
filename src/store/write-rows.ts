import type { CastIndex, ChunkRecord, FileRecord, LexicalIndex, SymbolRecord } from "../shared/types.js"
import type { SqliteDatabase as Database } from "./db.js"
import { tableExists } from "./schema.js"
import type { StoreFileResult as FileResult } from "./types.js"
import { chunkForStorage } from "./types.js"

function clearSqliteIndex(db: Database) {
  if (tableExists(db, "chunk_vectors")) {
    db.run("delete from chunk_vectors")
  }
  if (tableExists(db, "chunk_fts")) {
    db.run("delete from chunk_fts")
  }
  db.run("delete from chunk_rowids")
  db.run("delete from lexical")
  db.run("delete from symbols")
  db.run("delete from chunks")
  db.run("delete from file_runs")
  db.run("delete from files")
  db.run("delete from runs")
}

function insertRun(db: Database, runId: string, index: CastIndex) {
  db.run(
    "insert into runs (id, status, config_hash, started_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?)",
    [
      runId,
      index.metadata.status,
      JSON.stringify({
        embeddingModel: index.metadata.embeddingModel,
        embeddingDimensions: index.metadata.embeddingDimensions,
        maxChunkNonWhitespaceChars: index.metadata.maxChunkNonWhitespaceChars,
        chunking: index.metadata.chunking,
      }),
      index.metadata.updatedAt,
      index.metadata.updatedAt,
      JSON.stringify(index.metadata),
    ],
  )
}

function insertFile(db: Database, runId: string, file: FileRecord, updateGlobalFile = true) {
  if (updateGlobalFile) {
    upsertGlobalFile(db, file)
  }
  db.run(
    "insert or replace into file_runs (run_id, path, language, fingerprint, size_bytes, mtime_ms, ctime_ms, diagnostics_json, chunk_ids_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      runId,
      file.path,
      file.language,
      file.fingerprint,
      file.sizeBytes ?? null,
      file.mtimeMs ?? null,
      file.ctimeMs ?? null,
      JSON.stringify(file.diagnostics),
      JSON.stringify(file.chunkIds),
    ],
  )
}

function upsertGlobalFile(db: Database, file: FileRecord) {
  db.run(
    "insert or replace into files (path, language, fingerprint, size_bytes, mtime_ms, ctime_ms, diagnostics_json) values (?, ?, ?, ?, ?, ?, ?)",
    [
      file.path,
      file.language,
      file.fingerprint,
      file.sizeBytes ?? null,
      file.mtimeMs ?? null,
      file.ctimeMs ?? null,
      JSON.stringify(file.diagnostics),
    ],
  )
}

function insertChunks(db: Database, runId: string, chunks: ChunkRecord[]) {
  insertChunksWithVectorRowids(db, runId, chunks, nextVectorRowid(db))
}

function insertChunksWithVectorRowids(db: Database, runId: string, chunks: ChunkRecord[], initialVectorRowid: number) {
  let vectorRowid = initialVectorRowid
  for (const chunk of chunks) {
    db.run("insert into chunks (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
      runId,
      chunk.id,
      chunk.filePath,
      chunk.kind,
      JSON.stringify(chunkForStorage(chunk)),
    ])
    if (chunk.embedding) {
      db.run("insert into chunk_vectors (rowid, embedding) values (?, ?)", [
        sqliteVecRowid(vectorRowid),
        JSON.stringify(chunk.embedding),
      ])
      db.run("insert into chunk_rowids (run_id, chunk_id, rowid) values (?, ?, ?)", [runId, chunk.id, vectorRowid])
      vectorRowid += 1
    }
    db.run("insert into chunk_fts (run_id, id, content) values (?, ?, ?)", [runId, chunk.id, chunk.text])
  }
}

function nextVectorRowid(db: Database) {
  const row = db.query("select coalesce(max(rowid), 0) + 1 as rowid from chunk_rowids").get() as { rowid: number }
  return row.rowid
}

function sqliteVecRowid(rowid: number) {
  return BigInt(rowid)
}

function deleteRunFile(db: Database, runId: string, filePath: string) {
  const rows = db
    .query(
      "select chunk_rowids.rowid from chunk_rowids inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id where chunks.run_id = ? and chunks.file_path = ?",
    )
    .all(runId, filePath) as Array<{ rowid: number }>
  if (tableExists(db, "chunk_vectors")) {
    for (const row of rows) {
      db.run("delete from chunk_vectors where rowid = ?", [sqliteVecRowid(row.rowid)])
    }
  }
  db.run(
    "delete from chunk_rowids where run_id = ? and chunk_id in (select id from chunks where run_id = ? and file_path = ?)",
    [runId, runId, filePath],
  )
  db.run(
    "delete from chunk_fts where run_id = ? and id in (select id from chunks where run_id = ? and file_path = ?)",
    [runId, runId, filePath],
  )
  db.run("delete from chunks where run_id = ? and file_path = ?", [runId, filePath])
  db.run("delete from symbols where run_id = ? and file_path = ?", [runId, filePath])
  db.run("delete from file_runs where run_id = ? and path = ?", [runId, filePath])
}

function deleteRunRecords(db: Database, runId: string) {
  const rows = db.query("select rowid from chunk_rowids where run_id = ?").all(runId) as Array<{ rowid: number }>
  if (tableExists(db, "chunk_vectors")) {
    for (const row of rows) {
      db.run("delete from chunk_vectors where rowid = ?", [sqliteVecRowid(row.rowid)])
    }
  }
  db.run("delete from chunk_rowids where run_id = ?", [runId])
  db.run("delete from chunk_fts where run_id = ?", [runId])
  db.run("delete from lexical where run_id = ?", [runId])
  db.run("delete from symbols where run_id = ?", [runId])
  db.run("delete from chunks where run_id = ?", [runId])
  db.run("delete from file_runs where run_id = ?", [runId])
}

function pruneSupersededRuns(db: Database, activeRunId: string) {
  const runs = db.query("select id from runs where id != ?").all(activeRunId) as Array<{ id: string }>
  for (const run of runs) {
    deleteRunRecords(db, run.id)
    db.run("delete from runs where id = ?", [run.id])
  }
  db.run("delete from files where path not in (select path from file_runs where run_id = ?)", [activeRunId])
}

function insertSymbol(db: Database, runId: string, symbol: SymbolRecord) {
  db.run("insert into symbols (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
    runId,
    symbol.id,
    symbol.filePath,
    symbol.kind,
    JSON.stringify(symbol),
  ])
}

function insertLexical(db: Database, runId: string, lexical: LexicalIndex) {
  db.run("insert into lexical (run_id, metadata_json) values (?, ?)", [runId, JSON.stringify(lexical)])
}
function inferEmbeddingDimensions(index: CastIndex) {
  return (
    index.metadata.embeddingDimensions ??
    Object.values(index.chunks).find((chunk) => chunk.embedding)?.embedding?.length
  )
}

function inferFileResultEmbeddingDimensions(fileResult: FileResult) {
  return Object.values(fileResult.chunks).find((chunk) => chunk.embedding)?.embedding?.length
}

function inferFileResultsEmbeddingDimensions(fileResults: FileResult[]) {
  return fileResults.map(inferFileResultEmbeddingDimensions).find((dimensions) => dimensions !== undefined)
}

export {
  clearSqliteIndex,
  deleteRunFile,
  inferEmbeddingDimensions,
  inferFileResultEmbeddingDimensions,
  inferFileResultsEmbeddingDimensions,
  insertChunks,
  insertChunksWithVectorRowids,
  insertFile,
  insertLexical,
  insertRun,
  insertSymbol,
  pruneSupersededRuns,
  upsertGlobalFile,
}
