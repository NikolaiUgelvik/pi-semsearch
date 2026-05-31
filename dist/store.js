import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { load as loadSqliteVec } from "sqlite-vec";
import { matchesPaths } from "./path-filter.js";
const INDEX_SCHEMA_VERSION = 1;
const SQLITE_SCHEMA_VERSION = 3;
const RUN_ID_RANDOM_RADIX = 36;
const INDEX_STATUSES = ["empty", "indexing", "ready", "stale", "error"];
const CHUNK_KINDS = ["file", "class", "function", "method", "block", "fallback"];
const SYMBOL_KINDS = ["module", "class", "function", "method", "interface"];
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
        async searchVectorCandidates(queryEmbedding, topK, paths) {
            const db = await openSqliteIndex(file, embeddingDimensions ?? queryEmbedding.length);
            try {
                return searchSqliteVectorCandidates(db, queryEmbedding, topK, paths);
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
    const activeRun = db.query("select value from meta where key = 'active_run_id'").get();
    if (!activeRun) {
        return createEmptySqliteIndex(cacheKey, embeddingDimensions);
    }
    try {
        const metadata = readRunMetadata(db, activeRun.value);
        if (!metadata) {
            return createEmptySqliteIndex(cacheKey, embeddingDimensions, ["rebuilding corrupt index"]);
        }
        const files = readFiles(db, activeRun.value);
        const diagnostics = [...metadata.diagnostics];
        const index = {
            metadata: { ...metadata, diagnostics },
            files,
            chunks: readChunks(db, activeRun.value, readVectors(db, activeRun.value), {
                worktree: metadata.worktree,
                files,
                diagnostics,
            }),
            symbols: readSymbols(db, activeRun.value),
        };
        const lexical = readLexical(db, activeRun.value);
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
    const records = {};
    const files = db
        .query(`select file_runs.path,
              coalesce(file_runs.language, files.language) as language,
              coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
              coalesce(file_runs.diagnostics_json, files.diagnostics_json) as diagnosticsJson,
              file_runs.chunk_ids_json as chunkIdsJson
       from file_runs
       left join files on files.path = file_runs.path
       where file_runs.run_id = ?`)
        .all(runId);
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
    const write = db.transaction((result) => {
        deleteRunFile(db, runId, result.file.path);
        insertFile(db, runId, result.file, false);
        insertChunks(db, runId, Object.values(result.chunks));
        for (const symbol of Object.values(result.symbols)) {
            insertSymbol(db, runId, symbol);
        }
    });
    write(fileResult);
}
function activateSqliteRun(db, runId, index) {
    const activate = db.transaction((castIndex) => {
        deleteRunRecords(db, runId);
        for (const file of Object.values(castIndex.files)) {
            insertFile(db, runId, file);
        }
        insertChunks(db, runId, Object.values(castIndex.chunks));
        for (const symbol of Object.values(castIndex.symbols)) {
            insertSymbol(db, runId, symbol);
        }
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
function searchSqliteVectorCandidates(db, queryEmbedding, topK, paths) {
    const activeRun = db.query("select value from meta where key = 'active_run_id'").get();
    if (!activeRun || topK <= 0) {
        return [];
    }
    return scoreSqliteVectorRows(queryEmbedding, readSqliteVectorRows(db, activeRun.value), paths).slice(0, topK);
}
function readSqliteVectorRows(db, runId) {
    return db
        .query(`select chunk_rowids.chunk_id as id, vec_to_json(chunk_vectors.embedding) as embedding, chunks.file_path as filePath
       from chunk_rowids
       inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
       inner join chunks on chunks.run_id = chunk_rowids.run_id and chunks.id = chunk_rowids.chunk_id
       where chunk_rowids.run_id = ?`)
        .all(runId);
}
function scoreSqliteVectorRows(queryEmbedding, rows, paths) {
    return rows
        .filter((row) => matchesPaths(row.filePath, paths))
        .map((row) => ({ id: row.id, score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)) }))
        .sort((left, right) => bScoreThenId(left, right));
}
function bScoreThenId(left, right) {
    return right.score - left.score || left.id.localeCompare(right.id);
}
function clearSqliteIndex(db) {
    if (tableExists(db, "chunk_vectors")) {
        db.run("delete from chunk_vectors");
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
        db.run("insert or replace into files (path, language, fingerprint, diagnostics_json) values (?, ?, ?, ?)", [
            file.path,
            file.language,
            file.fingerprint,
            JSON.stringify(file.diagnostics),
        ]);
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
