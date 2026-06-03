import { tokenizeCodeText } from "./lexical.js";
import { compilePathFilters } from "./path-filter-compile.js";
import { sqlitePrefixPathFilter } from "./store-path-sql.js";
import { readActiveRunId } from "./store-read-rows.js";
import { tableExists } from "./store-schema.js";
const SQLITE_LEXICAL_PATH_FILTER_MULTIPLIER = 10;
const SQLITE_LEXICAL_PATH_FILTER_MAX_K = 1000;
const SQLITE_LEXICAL_FALLBACK_QUERY_TERMS = 16;
function searchSqliteLexicalCandidates(db, query, topK, paths) {
    const activeRunId = readActiveRunId(db);
    const target = Math.max(0, Math.floor(topK));
    if (!activeRunId || target <= 0 || query.trim().length === 0 || !tableExists(db, "chunk_fts")) {
        return [];
    }
    const pathFilters = compilePathFilters(paths);
    const pathFilter = sqlitePrefixPathFilter(pathFilters);
    const queryLimit = lexicalCandidateLimit(target, paths);
    try {
        return lexicalRowsToCandidates(querySqliteLexicalRows({ db, query, activeRunId, pathFilter, queryLimit }), target, pathFilters);
    }
    catch (error) {
        if (isFtsQuerySyntaxError(error)) {
            return searchTokenizedSqliteLexicalCandidates({
                db,
                query,
                activeRunId,
                pathFilter,
                queryLimit,
                target,
                pathFilters,
            });
        }
        throw error;
    }
}
function querySqliteLexicalRows(input) {
    return input.db
        .query(`select chunk_fts.id as id, chunks.file_path as filePath, chunk_fts.rank as rank
       from chunk_fts
       inner join chunks on chunks.run_id = chunk_fts.run_id and chunks.id = chunk_fts.id
       where chunk_fts match ? and chunk_fts.run_id = ?${input.pathFilter.sql}
       order by rank
       limit ?`)
        .all(input.query, input.activeRunId, ...input.pathFilter.args, input.queryLimit);
}
function searchTokenizedSqliteLexicalCandidates(input) {
    const fallbackQuery = tokenizedFtsQuery(input.query);
    if (!fallbackQuery) {
        return [];
    }
    try {
        return lexicalRowsToCandidates(querySqliteLexicalRows({ ...input, query: fallbackQuery }), input.target, input.pathFilters);
    }
    catch (error) {
        if (isFtsQuerySyntaxError(error)) {
            return [];
        }
        throw error;
    }
}
function lexicalRowsToCandidates(rows, target, pathFilters) {
    return rows
        .filter((row) => pathFilters.matches(row.filePath))
        .map((row) => ({ id: row.id, score: row.rank * -1, bm25Score: row.rank * -1 }))
        .slice(0, target);
}
function tokenizedFtsQuery(query) {
    const terms = [...new Set(tokenizeCodeText(query))]
        .filter((term) => term.length > 0)
        .slice(0, SQLITE_LEXICAL_FALLBACK_QUERY_TERMS);
    return terms.length === 0 ? undefined : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
function isFtsQuerySyntaxError(error) {
    if (!(error instanceof Error)) {
        return false;
    }
    return (error.message.includes("fts5: syntax error") ||
        error.message.includes("malformed MATCH expression") ||
        error.message.includes("unterminated string") ||
        error.message.startsWith("unknown special query: ") ||
        error.message.startsWith("no such column: "));
}
function lexicalCandidateLimit(topK, paths) {
    if (!paths || paths.length === 0) {
        return topK;
    }
    return Math.max(topK, Math.min(SQLITE_LEXICAL_PATH_FILTER_MAX_K, topK * SQLITE_LEXICAL_PATH_FILTER_MULTIPLIER));
}
export { searchSqliteLexicalCandidates };
