import path from "node:path";
import { openSqliteIndex } from "./db.js";
import { searchSqliteLexicalCandidates } from "./lexical-search.js";
import { hydrateSqliteChunks, readSqliteIndex, readSqliteMetadata } from "./read.js";
import { activateSqliteRun, beginSqliteIndexRun, getCompletedSqliteFile, writeSqliteFileResult, writeSqliteFileResults, writeSqliteIndex, } from "./run-writes.js";
import { searchSqliteVectorCandidates } from "./vector-search.js";
import { inferEmbeddingDimensions, inferFileResultEmbeddingDimensions, inferFileResultsEmbeddingDimensions, } from "./write-rows.js";
function createSqliteIndexStore(cacheDir, cacheKey, embeddingDimensions) {
    const file = path.join(cacheDir, cacheKey, "index.sqlite");
    const withDb = async (dimensions, operation) => {
        const db = await openSqliteIndex(file, dimensions);
        try {
            return await operation(db);
        }
        finally {
            db.close();
        }
    };
    return {
        read() {
            return withDb(embeddingDimensions, (db) => readSqliteIndex(db, cacheKey, embeddingDimensions));
        },
        write(index) {
            return withDb(embeddingDimensions ?? inferEmbeddingDimensions(index), (db) => writeSqliteIndex(db, index));
        },
        readMetadata() {
            return withDb(embeddingDimensions, (db) => readSqliteMetadata(db, cacheKey, embeddingDimensions));
        },
        hydrateChunks(chunkIds, options) {
            return withDb(embeddingDimensions, (db) => hydrateSqliteChunks({ db, cacheKey, embeddingDimensions, chunkIds, options }));
        },
        searchVectorCandidates(queryEmbedding, topK, paths) {
            if (queryEmbedding.length === 0 || topK <= 0) {
                return Promise.resolve([]);
            }
            return withDb(embeddingDimensions ?? queryEmbedding.length, (db) => searchSqliteVectorCandidates(db, queryEmbedding, topK, paths));
        },
        searchLexicalCandidates(query, topK, paths) {
            if (query.trim().length === 0 || topK <= 0) {
                return Promise.resolve([]);
            }
            return withDb(embeddingDimensions, (db) => searchSqliteLexicalCandidates(db, query, topK, paths));
        },
        beginIndexRun(input) {
            return withDb(embeddingDimensions, (db) => beginSqliteIndexRun(db, input.configHash, input.metadata));
        },
        getCompletedFile(runId, filePath, fingerprint) {
            return withDb(embeddingDimensions, (db) => getCompletedSqliteFile(db, runId, filePath, fingerprint));
        },
        writeFileResult(runId, fileResult) {
            return withDb(embeddingDimensions ?? inferFileResultEmbeddingDimensions(fileResult), (db) => writeSqliteFileResult(db, runId, fileResult));
        },
        writeFileResults(runId, fileResults) {
            return withDb(embeddingDimensions ?? inferFileResultsEmbeddingDimensions(fileResults), (db) => writeSqliteFileResults(db, runId, fileResults));
        },
        activateRun(runId, index) {
            return withDb(embeddingDimensions ?? inferEmbeddingDimensions(index), (db) => activateSqliteRun(db, runId, index));
        },
    };
}
export { createSqliteIndexStore };
