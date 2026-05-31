import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { load as loadSqliteVec } from "sqlite-vec";
import { matchesPaths } from "./path-filter.js";
const INDEX_SCHEMA_VERSION = 1;
const SQLITE_SCHEMA_VERSION = 4;
const RUN_ID_RANDOM_RADIX = 36;
const SQLITE_VECTOR_PATH_FILTER_INITIAL_K = 100;
const SQLITE_VECTOR_PATH_FILTER_MAX_K = 10_000;
const SQLITE_LEXICAL_PATH_FILTER_MULTIPLIER = 10;
const SQLITE_LEXICAL_PATH_FILTER_MAX_K = 1000;
const INDEX_STATUSES = ["empty", "indexing", "ready", "stale", "error"];
const CHUNK_KINDS = ["file", "class", "function", "method", "block", "fallback"];
const SYMBOL_KINDS = ["module", "class", "function", "method", "interface"];
const PATH_FILTER_GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/;
const DEFAULT_CHUNKING_OPTIONS = {
    overlap: 0,
    expansion: false,
    minSemanticNonWhitespaceChars: 8,
};
class CorruptIndexError extends Error {
    constructor(cause) {
        super("corrupt persisted index", { cause });
        this.name = "CorruptIndexError";
    }
}
function chunkForStorage(chunk) {
    const { text: _text, embedding: _embedding, ...storedChunk } = chunk;
    return storedChunk;
}
export function createEmptyIndex(input) {
    return {
        metadata: {
            schemaVersion: INDEX_SCHEMA_VERSION,
            projectId: input.projectId,
            worktree: input.worktree,
            cacheKey: input.cacheKey,
            maxChunkNonWhitespaceChars: input.maxChunkNonWhitespaceChars,
            chunking: input.chunking ?? DEFAULT_CHUNKING_OPTIONS,
            updatedAt: Date.now(),
            status: "empty",
            diagnostics: input.diagnostics ?? [],
        },
        files: {},
        chunks: {},
        symbols: {},
    };
}
export function createIndexStore(input) {
    return createSqliteIndexStore(input.cacheDir, input.cacheKey, input.embeddingDimensions);
}
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The store factory intentionally exposes the SQLite store API in one object.
function createSqliteIndexStore(cacheDir, cacheKey, embeddingDimensions) {
    const file = path.join(cacheDir, cacheKey, "index.sqlite");
    return {
        async read() {
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return readSqliteIndex(db, cacheKey, embeddingDimensions);
            }
            finally {
                db.close();
            }
        },
        async write(index) {
            const db = await openSqliteIndex(file, embeddingDimensions ?? inferEmbeddingDimensions(index));
            try {
                writeSqliteIndex(db, index);
            }
            finally {
                db.close();
            }
        },
        async readMetadata() {
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return readSqliteMetadata(db, cacheKey, embeddingDimensions);
            }
            finally {
                db.close();
            }
        },
        async hydrateChunks(chunkIds) {
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return hydrateSqliteChunks(db, cacheKey, embeddingDimensions, chunkIds);
            }
            finally {
                db.close();
            }
        },
        async searchVectorCandidates(queryEmbedding, topK, paths) {
            if (queryEmbedding.length === 0 || topK <= 0) {
                return [];
            }
            const db = await openSqliteIndex(file, embeddingDimensions ?? queryEmbedding.length);
            try {
                return searchSqliteVectorCandidates(db, queryEmbedding, topK, paths);
            }
            finally {
                db.close();
            }
        },
        async searchLexicalCandidates(query, topK, paths) {
            if (query.trim().length === 0 || topK <= 0) {
                return [];
            }
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return searchSqliteLexicalCandidates(db, query, topK, paths);
            }
            finally {
                db.close();
            }
        },
        async beginIndexRun(input) {
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return beginSqliteIndexRun(db, input.configHash, input.metadata);
            }
            finally {
                db.close();
            }
        },
        async getCompletedFile(runId, filePath, fingerprint) {
            const db = await openSqliteIndex(file, embeddingDimensions);
            try {
                return getCompletedSqliteFile(db, runId, filePath, fingerprint);
            }
            finally {
                db.close();
            }
        },
        async writeFileResult(runId, fileResult) {
            const db = await openSqliteIndex(file, embeddingDimensions ?? inferFileResultEmbeddingDimensions(fileResult));
            try {
                writeSqliteFileResult(db, runId, fileResult);
            }
            finally {
                db.close();
            }
        },
        async writeFileResults(runId, fileResults) {
            const db = await openSqliteIndex(file, embeddingDimensions ?? inferFileResultsEmbeddingDimensions(fileResults));
            try {
                writeSqliteFileResults(db, runId, fileResults);
            }
            finally {
                db.close();
            }
        },
        async activateRun(runId, index) {
            const db = await openSqliteIndex(file, embeddingDimensions ?? inferEmbeddingDimensions(index));
            try {
                activateSqliteRun(db, runId, index);
            }
            finally {
                db.close();
            }
        },
    };
}
async function openSqliteIndex(file, embeddingDimensions) {
    await mkdir(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
        loadSqliteVec(db);
        initializeSchema(db, embeddingDimensions);
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
function readSqliteIndex(db, cacheKey, embeddingDimensions) {
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions);
    }
    try {
        const metadata = readRunMetadata(db, activeRunId);
        if (!metadata) {
            return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
        }
        const files = readFiles(db, activeRunId);
        const diagnostics = [...metadata.diagnostics];
        const index = {
            metadata: { ...metadata, diagnostics },
            files,
            chunks: readChunks(db, activeRunId, readVectors(db, activeRunId), {
                worktree: metadata.worktree,
                files,
                diagnostics,
            }),
            symbols: readSymbols(db, activeRunId),
        };
        const lexical = readLexical(db, activeRunId);
        if (lexical) {
            index.lexical = lexical;
        }
        return isCastIndex(index)
            ? index
            : createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
    catch (error) {
        if (!(error instanceof CorruptIndexError)) {
            throw error;
        }
        return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
}
function readSqliteMetadata(db, cacheKey, embeddingDimensions) {
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions).metadata;
    }
    try {
        return (readRunMetadata(db, activeRunId) ??
            createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata);
    }
    catch (error) {
        if (!(error instanceof CorruptIndexError)) {
            throw error;
        }
        return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]).metadata;
    }
}
function hydrateSqliteChunks(db, cacheKey, embeddingDimensions, chunkIds) {
    const activeRunId = readActiveRunId(db);
    if (!activeRunId) {
        return emptyHydratedChunkSet(cacheKey, embeddingDimensions);
    }
    const metadata = readSqliteMetadata(db, cacheKey, embeddingDimensions);
    if (!metadata) {
        return emptyHydratedChunkSet(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
    }
    if (chunkIds.length === 0) {
        return { metadata, files: {}, chunks: {}, symbols: {}, diagnostics: [] };
    }
    const ids = chunkIdsWithTopology(db, activeRunId, chunkIds);
    const storedChunks = readStoredChunksByIds(db, activeRunId, ids);
    const orderedStoredChunks = ids.flatMap((chunkId) => {
        const chunk = storedChunks.get(chunkId);
        return chunk ? [chunk] : [];
    });
    const filePaths = [...new Set(orderedStoredChunks.map((chunk) => chunk.filePath))];
    const files = readFilesByPaths(db, activeRunId, filePaths);
    const diagnostics = [...metadata.diagnostics];
    const sourceContext = { worktree: metadata.worktree, files, diagnostics };
    const sourceCache = new Map();
    const vectors = readVectorsForChunkIds(db, activeRunId, ids);
    const chunks = {};
    for (const storedChunk of orderedStoredChunks) {
        const chunk = { ...storedChunk, text: readChunkText(sourceContext, sourceCache, storedChunk) };
        const embedding = vectors.get(chunk.id);
        if (embedding) {
            chunk.embedding = embedding;
        }
        chunks[chunk.id] = chunk;
    }
    const lexical = readLexical(db, activeRunId);
    const hydrated = {
        metadata: { ...metadata, diagnostics },
        files,
        chunks,
        symbols: readSymbolsByIds(db, activeRunId, [...new Set(Object.values(chunks).flatMap((chunk) => chunk.symbolIds))]),
        diagnostics,
    };
    if (lexical) {
        hydrated.lexical = lexical;
    }
    return hydrated;
}
function emptyHydratedChunkSet(cacheKey, embeddingDimensions, diagnostics) {
    return {
        metadata: createEmptySqliteIndex(cacheKey, embeddingDimensions, diagnostics).metadata,
        files: {},
        chunks: {},
        symbols: {},
        diagnostics: diagnostics ?? [],
    };
}
function chunkIdsWithTopology(db, runId, chunkIds) {
    const selected = readStoredChunksByIds(db, runId, [...new Set(chunkIds)]);
    const ids = selectedChunkIds(chunkIds, selected);
    appendRelatedChunkIds(ids, selected);
    return ids;
}
function selectedChunkIds(chunkIds, selected) {
    const ids = [];
    const seen = new Set();
    for (const chunkId of chunkIds) {
        if (seen.has(chunkId) || !selected.has(chunkId)) {
            continue;
        }
        ids.push(chunkId);
        seen.add(chunkId);
    }
    return ids;
}
function appendRelatedChunkIds(ids, selected) {
    const seen = new Set(ids);
    for (const chunkId of ids.slice()) {
        const chunk = selected.get(chunkId);
        if (!chunk) {
            continue;
        }
        for (const relatedId of relatedChunkIds(chunk)) {
            if (relatedId && !seen.has(relatedId)) {
                ids.push(relatedId);
                seen.add(relatedId);
            }
        }
    }
}
function relatedChunkIds(chunk) {
    return [chunk.parentChunkId, ...chunk.childChunkIds, chunk.previousSiblingChunkId, chunk.nextSiblingChunkId];
}
function readActiveRunId(db) {
    return db.query("select value from meta where key = 'active_run_id'").get()?.value;
}
function readRunMetadata(db, runId) {
    const run = db.query("select metadata_json as metadataJson from runs where id = ?").get(runId);
    return run ? parsePersistedJson(run.metadataJson) : undefined;
}
function createEmptySqliteIndex(cacheKey, embeddingDimensions, diagnostics) {
    const index = createEmptyIndex({
        projectId: cacheKey,
        worktree: "",
        cacheKey,
        maxChunkNonWhitespaceChars: 2000,
        diagnostics,
    });
    if (embeddingDimensions !== undefined) {
        index.metadata.embeddingDimensions = embeddingDimensions;
    }
    return index;
}
function readFiles(db, runId) {
    return fileRecordsFromRows(db
        .query(`select file_runs.path,
                coalesce(file_runs.language, files.language) as language,
                coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
                coalesce(file_runs.diagnostics_json, files.diagnostics_json) as diagnosticsJson,
                file_runs.chunk_ids_json as chunkIdsJson
         from file_runs
         left join files on files.path = file_runs.path
         where file_runs.run_id = ?`)
        .all(runId));
}
function readFilesByPaths(db, runId, filePaths) {
    if (filePaths.length === 0) {
        return {};
    }
    const placeholders = placeholdersFor(filePaths);
    return fileRecordsFromRows(db
        .query(`select file_runs.path,
                coalesce(file_runs.language, files.language) as language,
                coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
                coalesce(file_runs.diagnostics_json, files.diagnostics_json) as diagnosticsJson,
                file_runs.chunk_ids_json as chunkIdsJson
         from file_runs
         left join files on files.path = file_runs.path
         where file_runs.run_id = ? and file_runs.path in (${placeholders})`)
        .all(runId, ...filePaths));
}
function fileRecordsFromRows(files) {
    const records = {};
    for (const file of files) {
        records[file.path] = {
            path: file.path,
            language: file.language,
            fingerprint: file.fingerprint,
            chunkIds: parsePersistedJson(file.chunkIdsJson),
            diagnostics: parsePersistedJson(file.diagnosticsJson),
        };
    }
    return records;
}
function readStoredChunksByIds(db, runId, chunkIds) {
    const records = new Map();
    if (chunkIds.length === 0) {
        return records;
    }
    const placeholders = placeholdersFor(chunkIds);
    const chunks = db
        .query(`select id, record_json as recordJson from chunks where run_id = ? and id in (${placeholders})`)
        .all(runId, ...chunkIds);
    for (const chunk of chunks) {
        records.set(chunk.id, parsePersistedJson(chunk.recordJson));
    }
    return records;
}
function readVectors(db, runId) {
    const vectors = new Map();
    if (!tableExists(db, "chunk_vectors")) {
        return vectors;
    }
    const vectorRows = db
        .query("select chunk_rowids.chunk_id as chunkId, vec_to_json(chunk_vectors.embedding) as embedding from chunk_rowids inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid where chunk_rowids.run_id = ?")
        .all(runId);
    for (const row of vectorRows) {
        vectors.set(row.chunkId, parsePersistedJson(row.embedding));
    }
    return vectors;
}
function readVectorsForChunkIds(db, runId, chunkIds) {
    const vectors = new Map();
    if (chunkIds.length === 0 || !tableExists(db, "chunk_vectors")) {
        return vectors;
    }
    const placeholders = placeholdersFor(chunkIds);
    const vectorRows = db
        .query(`select chunk_rowids.chunk_id as chunkId, vec_to_json(chunk_vectors.embedding) as embedding
       from chunk_rowids
       inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
       where chunk_rowids.run_id = ? and chunk_rowids.chunk_id in (${placeholders})`)
        .all(runId, ...chunkIds);
    for (const row of vectorRows) {
        vectors.set(row.chunkId, parsePersistedJson(row.embedding));
    }
    return vectors;
}
function readChunks(db, runId, vectors, sourceContext) {
    const records = {};
    const sourceCache = new Map();
    const chunks = db.query("select id, record_json as recordJson from chunks where run_id = ?").all(runId);
    for (const chunk of chunks) {
        const storedRecord = parsePersistedJson(chunk.recordJson);
        if (sourceContext?.filePaths && !sourceContext.filePaths.has(storedRecord.filePath)) {
            continue;
        }
        const record = {
            ...storedRecord,
            text: readChunkText(sourceContext, sourceCache, storedRecord),
        };
        const embedding = vectors.get(chunk.id);
        if (embedding) {
            record.embedding = embedding;
        }
        records[chunk.id] = record;
    }
    return records;
}
function readFileChunks(input) {
    const records = {};
    if (input.file.chunkIds.length === 0) {
        return records;
    }
    const sourceCache = new Map();
    const placeholders = placeholdersFor(input.file.chunkIds);
    const chunks = input.db
        .query(`select id, record_json as recordJson
       from chunks
       where run_id = ? and file_path = ? and id in (${placeholders})`)
        .all(input.runId, input.file.path, ...input.file.chunkIds);
    for (const chunk of chunks) {
        const storedRecord = parsePersistedJson(chunk.recordJson);
        const record = {
            ...storedRecord,
            text: readChunkText(input.sourceContext, sourceCache, storedRecord),
        };
        const embedding = input.vectors.get(chunk.id);
        if (embedding) {
            record.embedding = embedding;
        }
        records[chunk.id] = record;
    }
    return records;
}
function readChunkText(sourceContext, sourceCache, chunk) {
    if (!sourceContext) {
        return "";
    }
    const source = readSource(sourceContext, sourceCache, chunk.filePath);
    if (!source.ok) {
        return "";
    }
    if (chunk.range.byteStart < 0 ||
        chunk.range.byteEnd < chunk.range.byteStart ||
        chunk.range.byteEnd > source.bytes.length) {
        sourceContext.diagnostics.push(`source range invalid for ${chunk.filePath}:${chunk.id}; chunk text unavailable`);
        return "";
    }
    return source.bytes.subarray(chunk.range.byteStart, chunk.range.byteEnd).toString();
}
function readSource(sourceContext, sourceCache, filePath) {
    const cached = sourceCache.get(filePath);
    if (cached) {
        return cached;
    }
    const result = readSourceUncached(sourceContext, filePath);
    sourceCache.set(filePath, result);
    return result;
}
function readSourceUncached(sourceContext, filePath) {
    try {
        const bytes = readFileSync(path.join(sourceContext.worktree, filePath));
        if (fingerprint(bytes) !== sourceContext.files[filePath]?.fingerprint) {
            sourceContext.diagnostics.push(`source fingerprint mismatch for ${filePath}; chunk text unavailable`);
            return { ok: false };
        }
        return { ok: true, bytes };
    }
    catch {
        sourceContext.diagnostics.push(`source read failed for ${filePath}; chunk text unavailable`);
        return { ok: false };
    }
}
function fingerprint(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
function readSymbols(db, runId) {
    const records = {};
    const symbols = db.query("select id, record_json as recordJson from symbols where run_id = ?").all(runId);
    for (const symbol of symbols) {
        records[symbol.id] = parsePersistedJson(symbol.recordJson);
    }
    return records;
}
function readSymbolsByIds(db, runId, symbolIds) {
    const records = {};
    if (symbolIds.length === 0) {
        return records;
    }
    const placeholders = placeholdersFor(symbolIds);
    const symbols = db
        .query(`select id, record_json as recordJson from symbols where run_id = ? and id in (${placeholders})`)
        .all(runId, ...symbolIds);
    for (const symbol of symbols) {
        records[symbol.id] = parsePersistedJson(symbol.recordJson);
    }
    return records;
}
function readSymbolsForFile(db, runId, filePath) {
    const records = {};
    const symbols = db
        .query("select id, record_json as recordJson from symbols where run_id = ? and file_path = ?")
        .all(runId, filePath);
    for (const symbol of symbols) {
        records[symbol.id] = parsePersistedJson(symbol.recordJson);
    }
    return records;
}
function placeholdersFor(values) {
    return values.map(() => "?").join(", ");
}
function readLexical(db, runId) {
    const lexical = db.query("select metadata_json as metadataJson from lexical where run_id = ?").get(runId);
    return lexical ? parsePersistedJson(lexical.metadataJson) : undefined;
}
function parsePersistedJson(json) {
    try {
        return JSON.parse(json);
    }
    catch (error) {
        throw new CorruptIndexError(error);
    }
}
function writeSqliteIndex(db, index) {
    const runId = `ready-${Date.now()}`;
    const write = db.transaction((castIndex) => {
        clearSqliteIndex(db);
        insertRun(db, runId, castIndex);
        for (const file of Object.values(castIndex.files)) {
            insertFile(db, runId, file);
        }
        insertChunksWithVectorRowids(db, runId, Object.values(castIndex.chunks), 1);
        for (const symbol of Object.values(castIndex.symbols)) {
            insertSymbol(db, runId, symbol);
        }
        if (castIndex.lexical) {
            insertLexical(db, runId, castIndex.lexical);
        }
        db.run("insert or replace into meta (key, value) values ('active_run_id', ?)", [runId]);
    });
    write(index);
}
function beginSqliteIndexRun(db, configHash, metadata) {
    const existing = db
        .query("select id from runs where status = 'indexing' and config_hash = ? order by started_at desc limit 1")
        .get(configHash);
    if (existing) {
        return { runId: existing.id };
    }
    const runId = `indexing-${Date.now()}-${Math.random().toString(RUN_ID_RANDOM_RADIX).slice(2)}`;
    db.run("insert into runs (id, status, config_hash, started_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?)", [
        runId,
        "indexing",
        configHash,
        Date.now(),
        null,
        JSON.stringify({ ...metadata, status: "indexing", updatedAt: Date.now() }),
    ]);
    return { runId };
}
function getCompletedSqliteFile(db, runId, filePath, fingerprint) {
    const file = db
        .query(`select path, language, fingerprint, diagnostics_json as diagnosticsJson, chunk_ids_json as chunkIdsJson
       from file_runs
       where run_id = ? and path = ? and fingerprint = ?`)
        .get(runId, filePath, fingerprint);
    if (!file) {
        return;
    }
    const record = {
        path: file.path,
        language: file.language,
        fingerprint: file.fingerprint,
        chunkIds: JSON.parse(file.chunkIdsJson),
        diagnostics: JSON.parse(file.diagnosticsJson),
    };
    const metadata = readRunMetadata(db, runId);
    if (!metadata) {
        return;
    }
    const diagnostics = [];
    const chunks = readFileChunks({
        db,
        runId,
        file: record,
        vectors: readVectorsForChunkIds(db, runId, record.chunkIds),
        sourceContext: {
            worktree: metadata.worktree,
            files: { [record.path]: record },
            diagnostics,
            filePaths: new Set([record.path]),
        },
    });
    if (diagnostics.length > 0) {
        return;
    }
    return {
        file: record,
        chunks: Object.fromEntries(record.chunkIds.map((id) => [id, chunks[id]]).filter((entry) => entry[1])),
        symbols: readSymbolsForFile(db, runId, filePath),
    };
}
function writeSqliteFileResult(db, runId, fileResult) {
    writeSqliteFileResults(db, runId, [fileResult]);
}
function writeSqliteFileResults(db, runId, fileResults) {
    const write = db.transaction((results) => {
        for (const result of results) {
            deleteRunFile(db, runId, result.file.path);
            insertFile(db, runId, result.file, false);
            insertChunks(db, runId, Object.values(result.chunks));
            for (const symbol of Object.values(result.symbols)) {
                insertSymbol(db, runId, symbol);
            }
        }
    });
    write(fileResults);
}
function activateSqliteRun(db, runId, index) {
    const activate = db.transaction((castIndex) => {
        validateCompletedRunRows(db, runId, castIndex);
        updateRunChunkLexicalStats(db, runId, castIndex.chunks);
        for (const file of Object.values(castIndex.files)) {
            upsertGlobalFile(db, file);
        }
        db.run("delete from lexical where run_id = ?", [runId]);
        if (castIndex.lexical) {
            insertLexical(db, runId, castIndex.lexical);
        }
        db.run("update runs set status = 'ready', completed_at = ?, metadata_json = ? where id = ?", [
            castIndex.metadata.updatedAt,
            JSON.stringify(castIndex.metadata),
            runId,
        ]);
        db.run("insert or replace into meta (key, value) values ('active_run_id', ?)", [runId]);
        pruneSupersededRuns(db, runId);
    });
    activate(index);
}
function updateRunChunkLexicalStats(db, runId, chunks) {
    const update = db.query("update chunks set record_json = ? where run_id = ? and id = ?");
    for (const chunk of Object.values(chunks)) {
        if (!chunk.lexical) {
            continue;
        }
        const row = db
            .query("select record_json as recordJson from chunks where run_id = ? and id = ?")
            .get(runId, chunk.id);
        if (!row) {
            continue;
        }
        update.run(JSON.stringify({ ...parsePersistedJson(row.recordJson), lexical: chunk.lexical }), runId, chunk.id);
    }
}
function validateCompletedRunRows(db, runId, index) {
    const run = db.query("select status from runs where id = ?").get(runId);
    const expected = Object.keys(index.files).sort();
    const rows = db.query("select path from file_runs where run_id = ? order by path").all(runId);
    const actual = rows.map((row) => row.path);
    if (run?.status !== "indexing" || !sameStringArray(actual, expected)) {
        throw new Error("incomplete indexing run cannot be activated");
    }
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function searchSqliteVectorCandidates(db, queryEmbedding, topK, paths) {
    const search = sqliteVectorSearchInput(db, queryEmbedding, topK, paths);
    if (!search) {
        return [];
    }
    const limits = sqliteVectorLimits(search.vectorCount, search.target, search.hasPathFilters);
    let currentK = limits.initial;
    const candidates = [];
    const seen = new Set();
    while (true) {
        appendMatchingSqliteVectorCandidates(candidates, seen, safeQuerySqliteVectorCandidates(db, search.activeRunId, queryEmbedding, currentK), paths);
        if (candidates.length >= search.target || currentK >= limits.max) {
            break;
        }
        currentK = Math.min(limits.max, currentK * 2);
    }
    return candidates.sort((left, right) => bScoreThenId(left, right)).slice(0, search.target);
}
function sqliteVectorSearchInput(db, queryEmbedding, topK, paths) {
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
        ? { activeRunId, target, vectorCount, hasPathFilters: paths !== undefined && paths.length > 0 }
        : null;
}
function canSearchSqliteVectors(db, queryEmbedding, target) {
    return (target > 0 && queryEmbedding.length > 0 && isValidQueryEmbedding(queryEmbedding) && tableExists(db, "chunk_vectors"));
}
function embeddingDimensionsMatch(db, runId, queryEmbedding) {
    const dimensions = readRunMetadata(db, runId)?.embeddingDimensions;
    return dimensions === undefined || queryEmbedding.length === dimensions;
}
function safeQuerySqliteVectorCandidates(db, runId, queryEmbedding, topK) {
    try {
        return querySqliteVectorCandidates(db, runId, queryEmbedding, topK);
    }
    catch (error) {
        if (isSqliteVecQueryEmbeddingError(error)) {
            return [];
        }
        throw error;
    }
}
function searchSqliteLexicalCandidates(db, query, topK, paths) {
    const activeRunId = readActiveRunId(db);
    const target = Math.max(0, Math.floor(topK));
    if (!activeRunId || target <= 0 || query.trim().length === 0 || !tableExists(db, "chunk_fts")) {
        return [];
    }
    const pathFilter = sqlPrefixPathFilter(paths);
    const queryLimit = lexicalCandidateLimit(target, paths);
    let rows;
    try {
        rows = db
            .query(`select chunk_fts.id as id, chunks.file_path as filePath, chunk_fts.rank as rank
         from chunk_fts
         inner join chunks on chunks.run_id = chunk_fts.run_id and chunks.id = chunk_fts.id
         where chunk_fts match ? and chunk_fts.run_id = ?${pathFilter.sql}
         order by rank
         limit ?`)
            .all(query, activeRunId, ...pathFilter.args, queryLimit);
    }
    catch (error) {
        if (isFtsQuerySyntaxError(error)) {
            return [];
        }
        throw error;
    }
    return rows
        .filter((row) => matchesPaths(row.filePath, paths))
        .map((row) => ({ id: row.id, score: row.rank * -1, bm25Score: row.rank * -1 }))
        .slice(0, target);
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
function sqlPrefixPathFilter(paths) {
    if (!paths || paths.length === 0 || paths.some(hasPathFilterGlobSyntax)) {
        return { sql: "", args: [] };
    }
    const clauses = [];
    const args = [];
    for (const filter of paths) {
        const prefix = filter.endsWith("/") ? filter : `${filter}/`;
        clauses.push("(chunks.file_path = ? or chunks.file_path like ? escape '\\')");
        args.push(filter, `${escapeSqlLike(prefix)}%`);
    }
    return { sql: ` and (${clauses.join(" or ")})`, args };
}
function hasPathFilterGlobSyntax(filter) {
    return PATH_FILTER_GLOB_SYNTAX_PATTERN.test(filter);
}
function escapeSqlLike(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
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
function appendMatchingSqliteVectorCandidates(candidates, seen, rows, paths) {
    for (const row of rows) {
        if (seen.has(row.id)) {
            continue;
        }
        seen.add(row.id);
        if (matchesPaths(row.filePath, paths)) {
            candidates.push({
                id: row.id,
                score: cosineSimilarity(row.queryEmbedding, parsePersistedJson(row.embedding)),
            });
        }
    }
}
function sqliteVectorLimits(vectorCount, topK, hasPathFilters) {
    const max = hasPathFilters
        ? Math.min(vectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_MAX_K))
        : Math.min(vectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K));
    const initial = hasPathFilters ? Math.min(vectorCount, Math.max(topK, SQLITE_VECTOR_PATH_FILTER_INITIAL_K)) : max;
    return { initial, max };
}
function readActiveVectorCount(db, runId) {
    const row = db
        .query(`select count(*) as count
       from chunk_rowids
       inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
       where chunk_rowids.run_id = ?`)
        .get(runId);
    return row.count;
}
function querySqliteVectorCandidates(db, runId, queryEmbedding, topK) {
    const rows = db
        .query(`select chunk_rowids.chunk_id as id,
              chunks.file_path as filePath,
              vec_to_json(chunk_vectors.embedding) as embedding
       from chunk_vectors
       inner join chunk_rowids on chunk_rowids.rowid = chunk_vectors.rowid
       inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
       where chunk_rowids.run_id = ? and chunk_vectors.embedding match ? and k = ?
      order by chunk_vectors.distance, chunk_rowids.chunk_id`)
        .all(runId, JSON.stringify(queryEmbedding), topK);
    return rows.map((row) => ({ ...row, queryEmbedding }));
}
function bScoreThenId(left, right) {
    return right.score - left.score || left.id.localeCompare(right.id);
}
function clearSqliteIndex(db) {
    if (tableExists(db, "chunk_vectors")) {
        db.run("delete from chunk_vectors");
    }
    if (tableExists(db, "chunk_fts")) {
        db.run("delete from chunk_fts");
    }
    db.run("delete from chunk_rowids");
    db.run("delete from lexical");
    db.run("delete from symbols");
    db.run("delete from chunks");
    db.run("delete from file_runs");
    db.run("delete from files");
    db.run("delete from runs");
}
function insertRun(db, runId, index) {
    db.run("insert into runs (id, status, config_hash, started_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?)", [
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
    ]);
}
function insertFile(db, runId, file, updateGlobalFile = true) {
    if (updateGlobalFile) {
        upsertGlobalFile(db, file);
    }
    db.run("insert or replace into file_runs (run_id, path, language, fingerprint, diagnostics_json, chunk_ids_json) values (?, ?, ?, ?, ?, ?)", [
        runId,
        file.path,
        file.language,
        file.fingerprint,
        JSON.stringify(file.diagnostics),
        JSON.stringify(file.chunkIds),
    ]);
}
function upsertGlobalFile(db, file) {
    db.run("insert or replace into files (path, language, fingerprint, diagnostics_json) values (?, ?, ?, ?)", [
        file.path,
        file.language,
        file.fingerprint,
        JSON.stringify(file.diagnostics),
    ]);
}
function insertChunks(db, runId, chunks) {
    insertChunksWithVectorRowids(db, runId, chunks, nextVectorRowid(db));
}
function insertChunksWithVectorRowids(db, runId, chunks, initialVectorRowid) {
    let vectorRowid = initialVectorRowid;
    for (const chunk of chunks) {
        db.run("insert into chunks (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
            runId,
            chunk.id,
            chunk.filePath,
            chunk.kind,
            JSON.stringify(chunkForStorage(chunk)),
        ]);
        if (chunk.embedding) {
            db.run("insert into chunk_vectors (rowid, embedding) values (?, ?)", [
                vectorRowid,
                JSON.stringify(chunk.embedding),
            ]);
            db.run("insert into chunk_rowids (run_id, chunk_id, rowid) values (?, ?, ?)", [runId, chunk.id, vectorRowid]);
            vectorRowid += 1;
        }
        db.run("insert into chunk_fts (run_id, id, content) values (?, ?, ?)", [runId, chunk.id, chunk.text]);
    }
}
function nextVectorRowid(db) {
    const row = db.query("select coalesce(max(rowid), 0) + 1 as rowid from chunk_rowids").get();
    return row.rowid;
}
function deleteRunFile(db, runId, filePath) {
    const rows = db
        .query("select chunk_rowids.rowid from chunk_rowids inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id where chunks.run_id = ? and chunks.file_path = ?")
        .all(runId, filePath);
    if (tableExists(db, "chunk_vectors")) {
        for (const row of rows) {
            db.run("delete from chunk_vectors where rowid = ?", [row.rowid]);
        }
    }
    db.run("delete from chunk_rowids where run_id = ? and chunk_id in (select id from chunks where run_id = ? and file_path = ?)", [runId, runId, filePath]);
    db.run("delete from chunk_fts where run_id = ? and id in (select id from chunks where run_id = ? and file_path = ?)", [runId, runId, filePath]);
    db.run("delete from chunks where run_id = ? and file_path = ?", [runId, filePath]);
    db.run("delete from symbols where run_id = ? and file_path = ?", [runId, filePath]);
    db.run("delete from file_runs where run_id = ? and path = ?", [runId, filePath]);
}
function deleteRunRecords(db, runId) {
    const rows = db.query("select rowid from chunk_rowids where run_id = ?").all(runId);
    if (tableExists(db, "chunk_vectors")) {
        for (const row of rows) {
            db.run("delete from chunk_vectors where rowid = ?", [row.rowid]);
        }
    }
    db.run("delete from chunk_rowids where run_id = ?", [runId]);
    db.run("delete from chunk_fts where run_id = ?", [runId]);
    db.run("delete from lexical where run_id = ?", [runId]);
    db.run("delete from symbols where run_id = ?", [runId]);
    db.run("delete from chunks where run_id = ?", [runId]);
    db.run("delete from file_runs where run_id = ?", [runId]);
}
function pruneSupersededRuns(db, activeRunId) {
    const runs = db.query("select id from runs where id != ?").all(activeRunId);
    for (const run of runs) {
        deleteRunRecords(db, run.id);
        db.run("delete from runs where id = ?", [run.id]);
    }
    db.run("delete from files where path not in (select path from file_runs where run_id = ?)", [activeRunId]);
}
function insertSymbol(db, runId, symbol) {
    db.run("insert into symbols (run_id, id, file_path, kind, record_json) values (?, ?, ?, ?, ?)", [
        runId,
        symbol.id,
        symbol.filePath,
        symbol.kind,
        JSON.stringify(symbol),
    ]);
}
function insertLexical(db, runId, lexical) {
    db.run("insert into lexical (run_id, metadata_json) values (?, ?)", [runId, JSON.stringify(lexical)]);
}
function initializeSchema(db, embeddingDimensions) {
    db.run("create table if not exists meta (key text primary key, value text not null)");
    db.run("insert or replace into meta (key, value) values ('schema_version', ?)", [String(SQLITE_SCHEMA_VERSION)]);
    db.run("create table if not exists runs (id text primary key, status text not null, config_hash text not null, started_at integer not null, completed_at integer, metadata_json text not null)");
    db.run("create table if not exists files (path text primary key, language text not null, fingerprint text not null, diagnostics_json text not null)");
    db.run("create table if not exists file_runs (run_id text not null, path text not null, chunk_ids_json text not null, primary key (run_id, path))");
    addColumnIfMissing(db, "file_runs", "language", "text");
    addColumnIfMissing(db, "file_runs", "fingerprint", "text");
    addColumnIfMissing(db, "file_runs", "diagnostics_json", "text");
    db.run("create table if not exists chunks (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))");
    db.run("create table if not exists symbols (run_id text not null, id text not null, file_path text not null, kind text not null, record_json text not null, primary key (run_id, id))");
    db.run("create table if not exists lexical (run_id text primary key, metadata_json text not null)");
    db.run("create table if not exists chunk_rowids (run_id text not null, chunk_id text not null, rowid integer not null, primary key (run_id, chunk_id))");
    if (embeddingDimensions !== undefined) {
        db.run(`create virtual table if not exists chunk_vectors using vec0(embedding float[${embeddingDimensions}])`);
    }
    db.run("create virtual table if not exists chunk_fts using fts5(run_id unindexed, id unindexed, content)");
}
function tableExists(db, table) {
    return Boolean(db.query("select name from sqlite_master where type = 'table' and name = ?").get(table));
}
function inferEmbeddingDimensions(index) {
    return (index.metadata.embeddingDimensions ??
        Object.values(index.chunks).find((chunk) => chunk.embedding)?.embedding?.length);
}
function inferFileResultEmbeddingDimensions(fileResult) {
    return Object.values(fileResult.chunks).find((chunk) => chunk.embedding)?.embedding?.length;
}
function inferFileResultsEmbeddingDimensions(fileResults) {
    return fileResults.map(inferFileResultEmbeddingDimensions).find((dimensions) => dimensions !== undefined);
}
function addColumnIfMissing(db, table, column, definition) {
    const columns = db.query(`pragma table_info(${table})`).all();
    if (!columns.some((existing) => existing.name === column)) {
        db.run(`alter table ${table} add column ${column} ${definition}`);
    }
}
export function cosineSimilarity(left, right) {
    const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
    const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
    const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}
export function searchVectors(query, vectors, topK) {
    return vectors
        .map((vector) => ({ id: vector.id, score: cosineSimilarity(query, vector.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, topK));
}
function isCastIndex(value) {
    return (isObject(value) &&
        isIndexMetadata(value.metadata) &&
        isRecordMap(value.files, isFileRecord) &&
        isRecordMap(value.chunks, isChunkRecord) &&
        isRecordMap(value.symbols, isSymbolRecord) &&
        (value.lexical === undefined || isLexicalIndex(value.lexical)));
}
function isIndexMetadata(value) {
    if (!isObject(value)) {
        return false;
    }
    return allPass([
        value.schemaVersion === INDEX_SCHEMA_VERSION,
        typeof value.projectId === "string",
        typeof value.worktree === "string",
        typeof value.cacheKey === "string",
        typeof value.maxChunkNonWhitespaceChars === "number",
        isChunkingOptions(value.chunking),
        typeof value.updatedAt === "number",
        INDEX_STATUSES.includes(value.status),
        isStringArray(value.diagnostics),
        isOptionalString(value.embeddingModel),
        isOptionalNumber(value.embeddingDimensions),
    ]);
}
function isChunkingOptions(value) {
    return (isObject(value) &&
        isNonnegativeNumber(value.overlap) &&
        Number.isInteger(value.overlap) &&
        typeof value.expansion === "boolean" &&
        typeof value.minSemanticNonWhitespaceChars === "number" &&
        Number.isInteger(value.minSemanticNonWhitespaceChars) &&
        value.minSemanticNonWhitespaceChars > 0);
}
function isFileRecord(value) {
    return (isObject(value) &&
        typeof value.path === "string" &&
        typeof value.language === "string" &&
        typeof value.fingerprint === "string" &&
        isStringArray(value.chunkIds) &&
        isStringArray(value.diagnostics));
}
function isChunkRecord(value) {
    if (!isObject(value)) {
        return false;
    }
    return allPass([
        typeof value.id === "string",
        typeof value.filePath === "string",
        typeof value.language === "string",
        CHUNK_KINDS.includes(value.kind),
        isSourceRange(value.range),
        typeof value.text === "string",
        typeof value.nonWhitespaceChars === "number",
        isStringArray(value.nodeTypes),
        isStringArray(value.symbolIds),
        isStringArray(value.childChunkIds),
        isOptionalString(value.parentChunkId),
        isOptionalString(value.previousSiblingChunkId),
        isOptionalString(value.nextSiblingChunkId),
        isOptionalNumberArray(value.embedding),
        isOptionalString(value.embeddingError),
        value.lexical === undefined || isChunkLexicalStats(value.lexical),
    ]);
}
function isLexicalIndex(value) {
    return (isObject(value) &&
        isNonnegativeNumber(value.documentCount) &&
        isNonnegativeNumber(value.averageDocumentLength) &&
        isRecordMap(value.documentFrequencies, isNonnegativeNumber));
}
function isChunkLexicalStats(value) {
    return isObject(value) && isNonnegativeNumber(value.length) && isRecordMap(value.termFrequencies, isNonnegativeNumber);
}
function isSymbolRecord(value) {
    if (!isObject(value)) {
        return false;
    }
    return allPass([
        typeof value.id === "string",
        typeof value.name === "string",
        SYMBOL_KINDS.includes(value.kind),
        typeof value.filePath === "string",
        isSourceRange(value.range),
        isOptionalString(value.parentSymbolId),
        isStringArray(value.childSymbolIds),
    ]);
}
function isSourceRange(value) {
    return (isObject(value) &&
        typeof value.byteStart === "number" &&
        typeof value.byteEnd === "number" &&
        typeof value.lineStart === "number" &&
        typeof value.lineEnd === "number");
}
function isRecordMap(value, isValue) {
    return isObject(value) && Object.values(value).every(isValue);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isNumberArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "number");
}
function isOptionalNumberArray(value) {
    return value === undefined || isNumberArray(value);
}
function isNonnegativeNumber(value) {
    return typeof value === "number" && value >= 0;
}
function isOptionalString(value) {
    return value === undefined || typeof value === "string";
}
function isOptionalNumber(value) {
    return value === undefined || typeof value === "number";
}
function allPass(checks) {
    return checks.every(Boolean);
}
