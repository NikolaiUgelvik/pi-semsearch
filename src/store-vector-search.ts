import { compilePathFilters } from "./path-filter-compile.js"
import type { CompiledPathFilters } from "./path-filter-types.js"
import type { SqliteDatabase as Database } from "./store-db.js"
import { sqlitePrefixPathFilter } from "./store-path-sql.js"
import { parsePersistedJson, readActiveRunId, readRunMetadata } from "./store-read-rows.js"
import { tableExists } from "./store-schema.js"
import type { RankedChunkCandidate, VectorCandidateSearchResult } from "./types.js"

const SQLITE_VECTOR_MAX_K = 4096
const SQLITE_VECTOR_PATH_FILTER_INITIAL_K = 100
const SQLITE_VECTOR_PATH_FILTER_MAX_K = SQLITE_VECTOR_MAX_K

function searchSqliteVectorCandidates(db: Database, queryEmbedding: number[], topK: number, paths?: string[]) {
  const pathFilters = compilePathFilters(paths)
  const search = sqliteVectorSearchInput(db, queryEmbedding, topK, pathFilters)
  if (!search) {
    return []
  }

  const result = collectSqliteVectorCandidates(db, queryEmbedding, pathFilters, search)
  return vectorCandidateSearchResult(sortVectorCandidates(result.candidates, search.target), {
    incomplete: result.incomplete,
  })
}

function collectSqliteVectorCandidates(
  db: Database,
  queryEmbedding: number[],
  pathFilters: CompiledPathFilters,
  search: NonNullable<ReturnType<typeof sqliteVectorSearchInput>>,
) {
  const limits = sqliteVectorLimits(search.vectorCount, search.target, search.hasPathFilters)
  const candidates: Array<{ id: string; score: number }> = []
  const seen = new Set<string>()
  let currentK = limits.initial

  while (currentK <= limits.max) {
    const rows = querySqliteVectorCandidateRows(db, search, queryEmbedding, currentK)
    appendMatchingSqliteVectorCandidates(candidates, seen, rows, pathFilters)
    if (candidates.length >= search.target || currentK >= limits.max) {
      return { candidates, incomplete: sqliteVectorSearchIncomplete(search, candidates.length, rows.length, currentK) }
    }
    currentK = Math.min(limits.max, currentK * 2)
  }
  return { candidates, incomplete: false }
}

function querySqliteVectorCandidateRows(
  db: Database,
  search: NonNullable<ReturnType<typeof sqliteVectorSearchInput>>,
  queryEmbedding: number[],
  currentK: number,
) {
  return safeQuerySqliteVectorCandidates({
    db,
    runId: search.activeRunId,
    queryEmbedding,
    topK: currentK,
    pathFilter: search.pathFilter,
  })
}

function sqliteVectorSearchIncomplete(
  search: NonNullable<ReturnType<typeof sqliteVectorSearchInput>>,
  candidateCount: number,
  rowCount: number,
  currentK: number,
) {
  return (
    search.hasPathFilters && candidateCount < search.target && rowCount >= currentK && currentK < search.vectorCount
  )
}

function sortVectorCandidates(candidates: RankedChunkCandidate[], target: number) {
  return candidates.sort((left, right) => bScoreThenId(left, right)).slice(0, target)
}

function vectorCandidateSearchResult(
  candidates: RankedChunkCandidate[],
  metadata: { incomplete: boolean },
): VectorCandidateSearchResult {
  return Object.assign(candidates, metadata.incomplete ? { incomplete: true } : {})
}

function sqliteVectorSearchInput(
  db: Database,
  queryEmbedding: number[],
  topK: number,
  pathFilters: CompiledPathFilters,
) {
  const activeRunId = readActiveRunId(db)
  const target = Math.max(0, Math.floor(topK))
  if (!activeRunId) {
    return null
  }
  if (!canSearchSqliteVectors(db, queryEmbedding, target)) {
    return null
  }
  if (!embeddingDimensionsMatch(db, activeRunId, queryEmbedding)) {
    return null
  }
  const vectorCount = readActiveVectorCount(db, activeRunId)
  return vectorCount > 0
    ? {
        activeRunId,
        target,
        vectorCount,
        hasPathFilters: pathFilters.prefixes.length > 0 || pathFilters.hasGlob,
        pathFilter: sqlitePrefixPathFilter(pathFilters),
      }
    : null
}

function canSearchSqliteVectors(db: Database, queryEmbedding: number[], target: number) {
  return (
    target > 0 && queryEmbedding.length > 0 && isValidQueryEmbedding(queryEmbedding) && tableExists(db, "chunk_vectors")
  )
}

function embeddingDimensionsMatch(db: Database, runId: string, queryEmbedding: number[]) {
  const dimensions = readRunMetadata(db, runId)?.embeddingDimensions
  return dimensions === undefined || queryEmbedding.length === dimensions
}

function safeQuerySqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlitePrefixPathFilter>
}) {
  try {
    return querySqliteVectorCandidates(input)
  } catch (error) {
    if (isSqliteVecQueryEmbeddingError(error)) {
      return []
    }
    throw error
  }
}
function isValidQueryEmbedding(queryEmbedding: number[]) {
  for (let index = 0; index < queryEmbedding.length; index += 1) {
    if (!Object.hasOwn(queryEmbedding, index)) {
      return false
    }
    if (typeof queryEmbedding[index] !== "number" || !Number.isFinite(queryEmbedding[index])) {
      return false
    }
  }
  return true
}

function isSqliteVecQueryEmbeddingError(error: unknown) {
  return error instanceof Error && error.message.includes("Dimension mismatch for query vector")
}

function appendMatchingSqliteVectorCandidates(
  candidates: Array<{ id: string; score: number }>,
  seen: Set<string>,
  rows: SqliteVectorCandidateRow[],
  pathFilters: CompiledPathFilters,
) {
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue
    }
    seen.add(row.id)
    if (pathFilters.matches(row.filePath)) {
      candidates.push({
        id: row.id,
        score: storeCosineSimilarity(row.queryEmbedding, parsePersistedJson<number[]>(row.embedding)),
      })
    }
  }
}

function sqliteVectorLimits(vectorCount: number, topK: number, hasPathFilters: boolean) {
  const boundedVectorCount = Math.min(vectorCount, SQLITE_VECTOR_MAX_K)
  const max = hasPathFilters
    ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_MAX_K))
    : Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K))
  const initial = hasPathFilters
    ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K))
    : max
  return { initial, max }
}

function readActiveVectorCount(db: Database, runId: string) {
  const row = db
    .query(
      `select count(*) as count
       from chunk_rowids
       where run_id = ?`,
    )
    .get(runId) as { count: number }
  return row.count
}

interface SqliteVectorRow {
  rowid: number
  embedding: string
}

interface SqliteVectorCandidateRow extends SqliteVectorRow {
  id: string
  filePath: string
  queryEmbedding: number[]
}

function querySqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlitePrefixPathFilter>
}) {
  if (input.pathFilter.sql) {
    return queryPathFilteredSqliteVectorCandidates(input)
  }
  const vectorRows = input.db
    .query(
      `select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (select rowid from chunk_rowids where run_id = ?) and embedding match ? and k = ?
       order by distance`,
    )
    .all(input.runId, JSON.stringify(input.queryEmbedding), input.topK) as SqliteVectorRow[]
  return sqliteVectorRowsToCandidateRows(input.db, input.runId, vectorRows, input.queryEmbedding)
}

function queryPathFilteredSqliteVectorCandidates(input: {
  db: Database
  runId: string
  queryEmbedding: number[]
  topK: number
  pathFilter: ReturnType<typeof sqlitePrefixPathFilter>
}) {
  const vectorRows = input.db
    .query(
      `select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (
         select chunk_rowids.rowid
         from chunk_rowids
         inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
          where chunk_rowids.run_id = ?${input.pathFilter.sql}
       ) and embedding match ? and k = ?
       order by distance`,
    )
    .all(input.runId, ...input.pathFilter.args, JSON.stringify(input.queryEmbedding), input.topK) as SqliteVectorRow[]
  return sqliteVectorRowsToCandidateRows(input.db, input.runId, vectorRows, input.queryEmbedding)
}

function sqliteVectorRowsToCandidateRows(
  db: Database,
  runId: string,
  vectorRows: SqliteVectorRow[],
  queryEmbedding: number[],
): SqliteVectorCandidateRow[] {
  const rowMetadata = readSqliteVectorRowMetadata(
    db,
    runId,
    vectorRows.map((row) => row.rowid),
  )
  return vectorRows.flatMap((row) => {
    const metadata = rowMetadata.get(row.rowid)
    return metadata ? [{ ...row, ...metadata, queryEmbedding }] : []
  })
}

function readSqliteVectorRowMetadata(db: Database, runId: string, rowids: number[]) {
  if (rowids.length === 0) {
    return new Map<number, { id: string; filePath: string }>()
  }
  const placeholders = rowids.map(() => "?").join(", ")
  const rows = db
    .query(
      `select chunk_rowids.rowid as rowid,
              chunk_rowids.chunk_id as id,
              chunks.file_path as filePath
       from chunk_rowids
       inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
       where chunk_rowids.run_id = ? and chunk_rowids.rowid in (${placeholders})`,
    )
    .all(runId, ...rowids) as Array<{ rowid: number; id: string; filePath: string }>
  return new Map(rows.map((row) => [row.rowid, { id: row.id, filePath: row.filePath }]))
}

function bScoreThenId(left: { id: string; score: number }, right: { id: string; score: number }) {
  return right.score - left.score || left.id.localeCompare(right.id)
}
function storeCosineSimilarity(left: number[], right: number[]) {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0))
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0))
  return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0
}

function rankVectorsByCosine(query: number[], vectors: Array<{ id: string; vector: number[] }>, topK: number) {
  return vectors
    .map((vector) => ({ id: vector.id, score: storeCosineSimilarity(query, vector.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK))
}

export { rankVectorsByCosine, searchSqliteVectorCandidates, storeCosineSimilarity }
