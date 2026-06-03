import path from "node:path"
import type { CastIndex } from "../shared/types.js"
import { type SqliteDatabase as Database, openSqliteIndex } from "./db.js"
import { searchSqliteLexicalCandidates } from "./lexical-search.js"
import { hydrateSqliteChunks, readSqliteIndex, readSqliteMetadata } from "./read.js"
import {
  activateSqliteRun,
  beginSqliteIndexRun,
  getCompletedSqliteFile,
  writeSqliteFileResult,
  writeSqliteFileResults,
  writeSqliteIndex,
} from "./run-writes.js"
import type { StoreFileResult as FileResult, StoreHydrateChunksOptions as HydrateChunksOptions } from "./types.js"
import { searchSqliteVectorCandidates } from "./vector-search.js"
import {
  inferEmbeddingDimensions,
  inferFileResultEmbeddingDimensions,
  inferFileResultsEmbeddingDimensions,
} from "./write-rows.js"

function createSqliteIndexStore(cacheDir: string, cacheKey: string, embeddingDimensions?: number) {
  const file = path.join(cacheDir, cacheKey, "index.sqlite")
  const withDb = async <T>(dimensions: number | undefined, operation: (db: Database) => T | Promise<T>): Promise<T> => {
    const db = await openSqliteIndex(file, dimensions)
    try {
      return await operation(db)
    } finally {
      db.close()
    }
  }

  return {
    read() {
      return withDb(embeddingDimensions, (db) => readSqliteIndex(db, cacheKey, embeddingDimensions))
    },
    write(index: CastIndex) {
      return withDb(embeddingDimensions ?? inferEmbeddingDimensions(index), (db) => writeSqliteIndex(db, index))
    },
    readMetadata() {
      return withDb(embeddingDimensions, (db) => readSqliteMetadata(db, cacheKey, embeddingDimensions))
    },
    hydrateChunks(chunkIds: string[], options?: HydrateChunksOptions) {
      return withDb(embeddingDimensions, (db) =>
        hydrateSqliteChunks({ db, cacheKey, embeddingDimensions, chunkIds, options }),
      )
    },
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]) {
      if (queryEmbedding.length === 0 || topK <= 0) {
        return Promise.resolve([])
      }
      return withDb(embeddingDimensions ?? queryEmbedding.length, (db) =>
        searchSqliteVectorCandidates(db, queryEmbedding, topK, paths),
      )
    },
    searchLexicalCandidates(query: string, topK: number, paths?: string[]) {
      if (query.trim().length === 0 || topK <= 0) {
        return Promise.resolve([])
      }
      return withDb(embeddingDimensions, (db) => searchSqliteLexicalCandidates(db, query, topK, paths))
    },
    beginIndexRun(input: { configHash: string; metadata: CastIndex["metadata"] }) {
      return withDb(embeddingDimensions, (db) => beginSqliteIndexRun(db, input.configHash, input.metadata))
    },
    getCompletedFile(runId: string, filePath: string, fingerprint: string) {
      return withDb(embeddingDimensions, (db) => getCompletedSqliteFile(db, runId, filePath, fingerprint))
    },
    writeFileResult(runId: string, fileResult: FileResult) {
      return withDb(embeddingDimensions ?? inferFileResultEmbeddingDimensions(fileResult), (db) =>
        writeSqliteFileResult(db, runId, fileResult),
      )
    },
    writeFileResults(runId: string, fileResults: FileResult[]) {
      return withDb(embeddingDimensions ?? inferFileResultsEmbeddingDimensions(fileResults), (db) =>
        writeSqliteFileResults(db, runId, fileResults),
      )
    },
    activateRun(runId: string, index: CastIndex) {
      return withDb(embeddingDimensions ?? inferEmbeddingDimensions(index), (db) => activateSqliteRun(db, runId, index))
    },
  }
}

export { createSqliteIndexStore }
