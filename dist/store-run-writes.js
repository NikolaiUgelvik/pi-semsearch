import { fileRecordFromRow, parsePersistedJson, readFileChunks, readRunMetadata, readSymbolsForFile, readVectorsForChunkIds, } from "./store-read-rows.js";
import { clearSqliteIndex, deleteRunFile, insertChunks, insertChunksWithVectorRowids, insertFile, insertLexical, insertRun, insertSymbol, pruneSupersededRuns, upsertGlobalFile, } from "./store-write-rows.js";
const RUN_ID_RANDOM_RADIX = 36;
const SQLITE_VACUUM_MIN_FREE_PAGES = 256;
const SQLITE_VACUUM_MIN_FREE_RATIO = 0.2;
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
    vacuumSqliteIndexIfNeeded(db);
}
function vacuumSqliteIndexIfNeeded(db) {
    const pageCount = readSqlitePragmaNumber(db, "page_count");
    const freePages = readSqlitePragmaNumber(db, "freelist_count");
    if (pageCount === 0 || freePages < SQLITE_VACUUM_MIN_FREE_PAGES) {
        return;
    }
    if (freePages / pageCount < SQLITE_VACUUM_MIN_FREE_RATIO) {
        return;
    }
    try {
        db.run("vacuum");
    }
    catch {
        // Optional maintenance; keep the index usable even if compaction is blocked by another connection.
    }
}
function readSqlitePragmaNumber(db, name) {
    const row = db.query(`pragma ${name}`).get();
    const value = row?.[name];
    return typeof value === "number" ? value : 0;
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
        .query(`select path, language, fingerprint, size_bytes as sizeBytes, mtime_ms as mtimeMs, ctime_ms as ctimeMs, diagnostics_json as diagnosticsJson, chunk_ids_json as chunkIdsJson
       from file_runs
       where run_id = ? and path = ? and fingerprint = ?`)
        .get(runId, filePath, fingerprint);
    if (!file) {
        return;
    }
    const record = fileRecordFromRow(file);
    const metadata = readRunMetadata(db, runId);
    if (!metadata) {
        return;
    }
    const diagnostics = [];
    const diagnosticDetails = [];
    const chunks = readFileChunks({
        db,
        runId,
        file: record,
        vectors: readVectorsForChunkIds(db, runId, record.chunkIds),
        sourceContext: {
            worktree: metadata.worktree,
            files: { [record.path]: record },
            diagnostics,
            diagnosticDetails,
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
    vacuumSqliteIndexIfNeeded(db);
}
function updateRunChunkLexicalStats(db, runId, chunks) {
    const select = db.query("select record_json as recordJson from chunks where run_id = ? and id = ?");
    const update = db.query("update chunks set record_json = ? where run_id = ? and id = ?");
    for (const chunk of Object.values(chunks)) {
        if (!chunk.lexical) {
            continue;
        }
        const row = select.get(runId, chunk.id);
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
export { activateSqliteRun, beginSqliteIndexRun, getCompletedSqliteFile, writeSqliteFileResult, writeSqliteFileResults, writeSqliteIndex, };
