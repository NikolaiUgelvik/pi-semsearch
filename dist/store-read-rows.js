import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tableExists } from "./store-schema.js";
import { CorruptIndexError } from "./store-types.js";
function hydrateStoredChunkRecord(input) {
    const record = {
        ...input.storedRecord,
        text: readChunkText(input.sourceContext, input.sourceCache, input.storedRecord),
    };
    const embedding = input.vectors.get(record.id);
    if (embedding) {
        record.embedding = embedding;
    }
    return record;
}
function readActiveRunId(db) {
    return db.query("select value from meta where key = 'active_run_id'").get()?.value;
}
function readRunMetadata(db, runId) {
    const run = db.query("select metadata_json as metadataJson from runs where id = ?").get(runId);
    return run ? parsePersistedJson(run.metadataJson) : undefined;
}
function readFiles(db, runId) {
    return fileRecordsFromRows(db
        .query(`select file_runs.path,
                coalesce(file_runs.language, files.language) as language,
                coalesce(file_runs.fingerprint, files.fingerprint) as fingerprint,
                coalesce(file_runs.size_bytes, files.size_bytes) as sizeBytes,
                coalesce(file_runs.mtime_ms, files.mtime_ms) as mtimeMs,
                coalesce(file_runs.ctime_ms, files.ctime_ms) as ctimeMs,
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
                coalesce(file_runs.size_bytes, files.size_bytes) as sizeBytes,
                coalesce(file_runs.mtime_ms, files.mtime_ms) as mtimeMs,
                coalesce(file_runs.ctime_ms, files.ctime_ms) as ctimeMs,
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
        records[file.path] = fileRecordFromRow(file);
    }
    return records;
}
function fileRecordFromRow(file) {
    const record = {
        path: file.path,
        language: file.language,
        fingerprint: file.fingerprint,
        chunkIds: parsePersistedJson(file.chunkIdsJson),
        diagnostics: parsePersistedJson(file.diagnosticsJson),
    };
    if (file.sizeBytes !== null) {
        record.sizeBytes = file.sizeBytes;
    }
    if (file.mtimeMs !== null) {
        record.mtimeMs = file.mtimeMs;
    }
    if (file.ctimeMs !== null) {
        record.ctimeMs = file.ctimeMs;
    }
    return record;
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
        const record = hydrateStoredChunkRecord({ storedRecord, vectors, sourceContext, sourceCache });
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
        const record = hydrateStoredChunkRecord({
            storedRecord,
            vectors: input.vectors,
            sourceContext: input.sourceContext,
            sourceCache,
        });
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
        addSourceHydrationDiagnostic(sourceContext, {
            code: "source.mismatch",
            filePath: chunk.filePath,
            chunkId: chunk.id,
            message: `source range invalid for ${chunk.filePath}:${chunk.id}; chunk text unavailable`,
        });
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
            addSourceHydrationDiagnostic(sourceContext, {
                code: "source.mismatch",
                filePath,
                message: `source fingerprint mismatch for ${filePath}; chunk text unavailable`,
            });
            return { ok: false };
        }
        return { ok: true, bytes };
    }
    catch {
        addSourceHydrationDiagnostic(sourceContext, {
            code: "source.read_failed",
            filePath,
            message: `source read failed for ${filePath}; chunk text unavailable`,
        });
        return { ok: false };
    }
}
function addSourceHydrationDiagnostic(sourceContext, detail) {
    sourceContext.diagnostics.push(detail.message);
    sourceContext.diagnosticDetails.push(detail);
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
export { fileRecordFromRow, hydrateStoredChunkRecord, parsePersistedJson, readActiveRunId, readChunks, readFileChunks, readFiles, readFilesByPaths, readLexical, readRunMetadata, readStoredChunksByIds, readSymbols, readSymbolsByIds, readSymbolsForFile, readVectors, readVectorsForChunkIds, };
