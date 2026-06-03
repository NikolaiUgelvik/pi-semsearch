import { compilePathFilters } from "../path-filter/compile.js";
import { sqlitePrefixPathFilter } from "./path-sql.js";
import { parsePersistedJson, readActiveRunId, readRunMetadata } from "./read-rows.js";
import { tableExists } from "./schema.js";
const SQLITE_VECTOR_MAX_K = 4096;
const SQLITE_VECTOR_PATH_FILTER_INITIAL_K = 100;
const SQLITE_VECTOR_PATH_FILTER_MAX_K = SQLITE_VECTOR_MAX_K;
function searchSqliteVectorCandidates(db, queryEmbedding, topK, paths) {
    const pathFilters = compilePathFilters(paths);
    const search = sqliteVectorSearchInput(db, queryEmbedding, topK, pathFilters);
    if (!search) {
        return [];
    }
    const result = collectSqliteVectorCandidates(db, queryEmbedding, pathFilters, search);
    return vectorCandidateSearchResult(sortVectorCandidates(result.candidates, search.target), {
        incomplete: result.incomplete,
    });
}
function collectSqliteVectorCandidates(db, queryEmbedding, pathFilters, search) {
    const limits = sqliteVectorLimits(search.vectorCount, search.target, search.hasPathFilters);
    const candidates = [];
    const seen = new Set();
    let currentK = limits.initial;
    while (currentK <= limits.max) {
        const rows = querySqliteVectorCandidateRows(db, search, queryEmbedding, currentK);
        appendMatchingSqliteVectorCandidates(candidates, seen, rows, pathFilters);
        if (candidates.length >= search.target || currentK >= limits.max) {
            return { candidates, incomplete: sqliteVectorSearchIncomplete(search, candidates.length, rows.length, currentK) };
        }
        currentK = Math.min(limits.max, currentK * 2);
    }
    return { candidates, incomplete: false };
}
function querySqliteVectorCandidateRows(db, search, queryEmbedding, currentK) {
    return safeQuerySqliteVectorCandidates({
        db,
        runId: search.activeRunId,
        queryEmbedding,
        topK: currentK,
        pathFilter: search.pathFilter,
    });
}
function sqliteVectorSearchIncomplete(search, candidateCount, rowCount, currentK) {
    return (search.hasPathFilters && candidateCount < search.target && rowCount >= currentK && currentK < search.vectorCount);
}
function sortVectorCandidates(candidates, target) {
    return candidates.sort((left, right) => bScoreThenId(left, right)).slice(0, target);
}
function vectorCandidateSearchResult(candidates, metadata) {
    return Object.assign(candidates, metadata.incomplete ? { incomplete: true } : {});
}
function sqliteVectorSearchInput(db, queryEmbedding, topK, pathFilters) {
    const activeRunId = readActiveRunId(db);
    const target = Math.max(0, Math.floor(topK));
    if (!activeRunId) {
        return null;
    }
    if (!canSearchSqliteVectors(db, queryEmbedding, target)) {
        return null;
    }
    if (!embeddingDimensionsMatch(db, activeRunId, queryEmbedding)) {
        return null;
    }
    const vectorCount = readActiveVectorCount(db, activeRunId);
    return vectorCount > 0
        ? {
            activeRunId,
            target,
            vectorCount,
            hasPathFilters: pathFilters.prefixes.length > 0 || pathFilters.hasGlob,
            pathFilter: sqlitePrefixPathFilter(pathFilters),
        }
        : null;
}
function canSearchSqliteVectors(db, queryEmbedding, target) {
    return (target > 0 && queryEmbedding.length > 0 && isValidQueryEmbedding(queryEmbedding) && tableExists(db, "chunk_vectors"));
}
function embeddingDimensionsMatch(db, runId, queryEmbedding) {
    const dimensions = readRunMetadata(db, runId)?.embeddingDimensions;
    return dimensions === undefined || queryEmbedding.length === dimensions;
}
function safeQuerySqliteVectorCandidates(input) {
    try {
        return querySqliteVectorCandidates(input);
    }
    catch (error) {
        if (isSqliteVecQueryEmbeddingError(error)) {
            return [];
        }
        throw error;
    }
}
function isValidQueryEmbedding(queryEmbedding) {
    for (let index = 0; index < queryEmbedding.length; index += 1) {
        if (!Object.hasOwn(queryEmbedding, index)) {
            return false;
        }
        if (typeof queryEmbedding[index] !== "number" || !Number.isFinite(queryEmbedding[index])) {
            return false;
        }
    }
    return true;
}
function isSqliteVecQueryEmbeddingError(error) {
    return error instanceof Error && error.message.includes("Dimension mismatch for query vector");
}
function appendMatchingSqliteVectorCandidates(candidates, seen, rows, pathFilters) {
    for (const row of rows) {
        if (seen.has(row.id)) {
            continue;
        }
        seen.add(row.id);
        if (pathFilters.matches(row.filePath)) {
            candidates.push({
                id: row.id,
                score: storeCosineSimilarity(row.queryEmbedding, parsePersistedJson(row.embedding)),
            });
        }
    }
}
function sqliteVectorLimits(vectorCount, topK, hasPathFilters) {
    const boundedVectorCount = Math.min(vectorCount, SQLITE_VECTOR_MAX_K);
    const max = hasPathFilters
        ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_MAX_K))
        : Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K));
    const initial = hasPathFilters
        ? Math.min(boundedVectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K))
        : max;
    return { initial, max };
}
function readActiveVectorCount(db, runId) {
    const row = db
        .query(`select count(*) as count
       from chunk_rowids
       where run_id = ?`)
        .get(runId);
    return row.count;
}
function querySqliteVectorCandidates(input) {
    if (input.pathFilter.sql) {
        return queryPathFilteredSqliteVectorCandidates(input);
    }
    const vectorRows = input.db
        .query(`select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (select rowid from chunk_rowids where run_id = ?) and embedding match ? and k = ?
       order by distance`)
        .all(input.runId, JSON.stringify(input.queryEmbedding), input.topK);
    return sqliteVectorRowsToCandidateRows(input.db, input.runId, vectorRows, input.queryEmbedding);
}
function queryPathFilteredSqliteVectorCandidates(input) {
    const vectorRows = input.db
        .query(`select rowid,
              vec_to_json(embedding) as embedding
       from chunk_vectors
       where rowid in (
         select chunk_rowids.rowid
         from chunk_rowids
         inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
          where chunk_rowids.run_id = ?${input.pathFilter.sql}
       ) and embedding match ? and k = ?
       order by distance`)
        .all(input.runId, ...input.pathFilter.args, JSON.stringify(input.queryEmbedding), input.topK);
    return sqliteVectorRowsToCandidateRows(input.db, input.runId, vectorRows, input.queryEmbedding);
}
function sqliteVectorRowsToCandidateRows(db, runId, vectorRows, queryEmbedding) {
    const rowMetadata = readSqliteVectorRowMetadata(db, runId, vectorRows.map((row) => row.rowid));
    return vectorRows.flatMap((row) => {
        const metadata = rowMetadata.get(row.rowid);
        return metadata ? [{ ...row, ...metadata, queryEmbedding }] : [];
    });
}
function readSqliteVectorRowMetadata(db, runId, rowids) {
    if (rowids.length === 0) {
        return new Map();
    }
    const placeholders = rowids.map(() => "?").join(", ");
    const rows = db
        .query(`select chunk_rowids.rowid as rowid,
              chunk_rowids.chunk_id as id,
              chunks.file_path as filePath
       from chunk_rowids
       inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
       where chunk_rowids.run_id = ? and chunk_rowids.rowid in (${placeholders})`)
        .all(runId, ...rowids);
    return new Map(rows.map((row) => [row.rowid, { id: row.id, filePath: row.filePath }]));
}
function bScoreThenId(left, right) {
    return right.score - left.score || left.id.localeCompare(right.id);
}
function storeCosineSimilarity(left, right) {
    const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
    const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
    const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
function rankVectorsByCosine(query, vectors, topK) {
    return vectors
        .map((vector) => ({ id: vector.id, score: storeCosineSimilarity(query, vector.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, topK));
}
export { rankVectorsByCosine, searchSqliteVectorCandidates, storeCosineSimilarity };
