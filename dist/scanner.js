import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { Minimatch } from "minimatch";
import { castChunks } from "./cast.js";
import { fallbackChunks } from "./fallback.js";
import { buildLexicalIndex } from "./lexical.js";
import { createSourceIndex } from "./range.js";
import { assignSymbolsToChunks, attachTopology, extractSymbols } from "./topology.js";
const BINARY_SAMPLE_BYTES = Number("16") * Number("1024");
const BYTE_NUL = 0;
const BYTE_BACKSPACE = 8;
const BYTE_TAB = 9;
const BYTE_LINE_FEED = 10;
const BYTE_FORM_FEED = 12;
const BYTE_CARRIAGE_RETURN = 13;
const CONTROL_BYTE_LIMIT = 32;
const BINARY_CONTROL_RATIO = 0.3;
const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
const DEFAULT_EMBEDDING_BATCH_CONCURRENCY = 1;
const DEFAULT_FILE_CONCURRENCY = 4;
const DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE = 32;
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".cache"]);
const MAX_QUEUED_REUSED_FILE_RESULTS = 256;
const STAT_FAST_PATH_SETTLE_MS = 1000;
const TRAILING_SLASHES = /\/+$/;
export function createIndexer(input) {
    return {
        async refresh(signal) {
            signal?.throwIfAborted();
            const store = input.store;
            const index = await store.read();
            signal?.throwIfAborted();
            const runStore = hasRunStore(store) ? store : undefined;
            const state = createRefreshState(index, input);
            const runController = createIndexRunController(index, input, runStore);
            const embeddingBatcher = createEmbeddingBatcher(input, signal);
            const fileResultWriter = createFileResultWriter({ runStore, run: runController.run });
            const changed = await processScannedFiles({
                files: scanFiles(input.worktree, input.options.includeGlobs, input.options.excludeGlobs),
                input,
                index,
                state,
                runStore,
                run: runController.run,
                ensureRun: runController.ensureRun,
                embeddingBatcher,
                fileResultWriter,
                signal,
            });
            signal?.throwIfAborted();
            await embeddingBatcher.drain();
            signal?.throwIfAborted();
            await fileResultWriter.flush();
            state.metadataDiagnostics.sort();
            const lexicalIndex = buildLexicalIndex(state.nextChunks, state.nextSymbols);
            const hasFileSetChange = !sameStringArray(Object.keys(index.files).sort(), Object.keys(state.nextFiles).sort());
            const hasDiagnosticsChange = !sameStringArray(index.metadata.diagnostics, state.metadataDiagnostics);
            const hasDiagnosticDetailsChange = stableStringify(index.metadata.diagnosticDetails ?? []) !== stableStringify(state.metadataDiagnosticDetails);
            const hasScannerOptionsChange = !sameScannerOptions(index.metadata, input.options);
            if (canSkipRefresh(index, input.worktree, changed || state.reusedRecordsChanged, state.canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange || hasDiagnosticDetailsChange || hasScannerOptionsChange)) {
                return index;
            }
            await flushQueuedReusedFileResults({
                state,
                runStore,
                run: runController.run,
                ensureRun: runController.ensureRun,
                fileResultWriter,
            });
            await fileResultWriter.flush();
            signal?.throwIfAborted();
            await persistRefreshState({
                index,
                store,
                runStore,
                run: runController.run,
                ensureRun: runController.ensureRun,
                scannerInput: input,
                state,
                lexicalIndex,
            });
            return index;
        },
        async refreshFile(filePath, signal) {
            signal?.throwIfAborted();
            const store = input.store;
            const index = await store.read();
            signal?.throwIfAborted();
            if (!canSingleFileRefresh(index, input)) {
                return this.refresh(signal);
            }
            const relativePath = worktreeRelativePath(input.worktree, filePath);
            if (!relativePath) {
                return index;
            }
            const previousState = singleFileStateSnapshot(index, relativePath);
            const state = createSingleFileRefreshState(index, input, relativePath);
            const shouldIndex = await shouldIndexSingleFile(input, relativePath);
            const absolutePath = path.join(input.worktree, relativePath);
            const fileStat = shouldIndex ? await statFileForIndexing(absolutePath) : undefined;
            if (fileStat) {
                const embeddingBatcher = createEmbeddingBatcher(input, signal);
                await processScannedFile({
                    input,
                    index,
                    state,
                    relativePath,
                    runStore: undefined,
                    run: () => undefined,
                    ensureRun: async () => undefined,
                    embeddingBatcher,
                    fileResultWriter: createFileResultWriter({ runStore: undefined, run: () => undefined }),
                    signal,
                });
                signal?.throwIfAborted();
                await embeddingBatcher.drain();
            }
            signal?.throwIfAborted();
            state.metadataDiagnostics.sort();
            const lexicalIndex = buildSingleFileLexicalIndex(state, relativePath);
            if (!singleFileRefreshChanged(index, relativePath, state, lexicalIndex, previousState)) {
                return index;
            }
            await persistRefreshState({
                index,
                store,
                runStore: undefined,
                run: () => undefined,
                ensureRun: async () => undefined,
                scannerInput: input,
                state,
                lexicalIndex,
            });
            return index;
        },
    };
}
function createRefreshState(index, input) {
    return {
        nextFiles: {},
        nextChunks: {},
        nextSymbols: {},
        symbolsByFilePath: symbolsByFilePath(index.symbols),
        metadataDiagnostics: [],
        metadataDiagnosticDetails: [],
        reusedFileResults: [],
        canReuseExistingRecords: canReuseExistingIndexRecords(index, input),
        reusedRecordsChanged: false,
        changed: false,
    };
}
function canReuseExistingIndexRecords(index, input) {
    return (index.metadata.maxChunkNonWhitespaceChars === input.options.maxChunkNonWhitespaceChars &&
        sameChunkingOptions(index.metadata.chunking, input.options.chunking));
}
function canSingleFileRefresh(index, input) {
    return (index.metadata.status === "ready" &&
        index.metadata.worktree === input.worktree &&
        sameScannerOptions(index.metadata, input.options) &&
        canReuseExistingIndexRecords(index, input));
}
function createSingleFileRefreshState(index, input, relativePath) {
    const state = createRefreshState(index, input);
    state.nextFiles = { ...index.files };
    state.nextChunks = { ...index.chunks };
    state.nextSymbols = { ...index.symbols };
    state.metadataDiagnostics = (index.metadata.diagnostics ?? []).filter((diagnostic) => !diagnosticBelongsToFile(diagnostic, relativePath));
    state.metadataDiagnosticDetails = (index.metadata.diagnosticDetails ?? []).filter((diagnostic) => diagnostic.filePath !== relativePath);
    removeFileRecordsFromState(state, relativePath);
    return state;
}
function removeFileRecordsFromState(state, relativePath) {
    delete state.nextFiles[relativePath];
    for (const [chunkId, chunk] of Object.entries(state.nextChunks)) {
        if (chunk.filePath === relativePath) {
            delete state.nextChunks[chunkId];
        }
    }
    for (const [symbolId, symbol] of Object.entries(state.nextSymbols)) {
        if (symbol.filePath === relativePath) {
            delete state.nextSymbols[symbolId];
        }
    }
}
function diagnosticBelongsToFile(diagnostic, relativePath) {
    return diagnostic === relativePath || diagnostic.startsWith(`${relativePath}:`);
}
function singleFileStateSnapshot(index, relativePath) {
    return stableStringify({
        file: index.files[relativePath],
        chunks: Object.fromEntries(Object.entries(index.chunks).filter(([, chunk]) => chunk.filePath === relativePath)),
        symbols: Object.fromEntries(Object.entries(index.symbols).filter(([, symbol]) => symbol.filePath === relativePath)),
        diagnostics: index.metadata.diagnostics ?? [],
        diagnosticDetails: index.metadata.diagnosticDetails ?? [],
    });
}
function buildSingleFileLexicalIndex(state, relativePath) {
    const changedChunks = Object.fromEntries(Object.entries(state.nextChunks).filter(([, chunk]) => chunk.filePath === relativePath));
    const indexedChangedChunks = buildLexicalIndex(changedChunks, state.nextSymbols).chunks;
    const chunks = { ...state.nextChunks, ...indexedChangedChunks };
    return { lexical: lexicalIndexFromChunks(chunks), chunks };
}
function lexicalIndexFromChunks(chunks) {
    const documentFrequencies = Object.create(null);
    let documentCount = 0;
    let totalLength = 0;
    for (const chunk of Object.values(chunks)) {
        const lexical = chunk.lexical;
        if (!lexical) {
            continue;
        }
        documentCount += 1;
        totalLength += lexical.length;
        for (const term of Object.keys(lexical.termFrequencies)) {
            documentFrequencies[term] = (documentFrequencies[term] ?? 0) + 1;
        }
    }
    return {
        documentCount,
        averageDocumentLength: documentCount === 0 ? 0 : totalLength / documentCount,
        documentFrequencies,
    };
}
function singleFileRefreshChanged(index, relativePath, state, lexicalIndex, previousState) {
    const nextState = stableStringify({
        file: state.nextFiles[relativePath],
        chunks: Object.fromEntries(Object.entries(lexicalIndex.chunks).filter(([, chunk]) => chunk.filePath === relativePath)),
        symbols: Object.fromEntries(Object.entries(state.nextSymbols).filter(([, symbol]) => symbol.filePath === relativePath)),
        diagnostics: state.metadataDiagnostics,
        diagnosticDetails: state.metadataDiagnosticDetails,
    });
    return previousState !== nextState || Object.keys(index.files).length !== Object.keys(state.nextFiles).length;
}
function createIndexRunController(index, input, runStore) {
    let run;
    let runPromise;
    return {
        run: () => run,
        ensureRun: async () => {
            if (!runStore) {
                return;
            }
            if (!runPromise) {
                markIndexing(index, input);
                runPromise = runStore.beginIndexRun({
                    configHash: indexRunConfigHash(index, input.worktree, input.options),
                    metadata: index.metadata,
                });
            }
            run = run ?? (await runPromise);
            return run;
        },
    };
}
function markIndexing(index, input) {
    index.metadata.status = "indexing";
    applyScannerMetadata(index, input);
}
function applyScannerMetadata(index, input) {
    index.metadata.worktree = input.worktree;
    index.metadata.maxFileBytes = input.options.maxFileBytes;
    index.metadata.includeGlobs = input.options.includeGlobs;
    index.metadata.excludeGlobs = input.options.excludeGlobs;
    index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars;
    index.metadata.chunking = input.options.chunking;
}
async function processScannedFiles(input) {
    const inFlight = new Set();
    let failed = false;
    let firstError;
    const recordFailure = (error) => {
        if (!failed) {
            failed = true;
            firstError = error;
        }
    };
    const waitForCapacity = async () => {
        while (!failed && inFlight.size >= DEFAULT_FILE_CONCURRENCY) {
            await Promise.race(inFlight);
        }
    };
    try {
        for await (const relativePath of input.files) {
            input.signal?.throwIfAborted();
            await waitForCapacity();
            input.signal?.throwIfAborted();
            if (failed) {
                break;
            }
            const worker = processScannedFile({ ...input, relativePath })
                .then((nextChanged) => {
                input.state.changed = input.state.changed || nextChanged;
            })
                .catch(recordFailure)
                .finally(() => {
                inFlight.delete(worker);
            });
            inFlight.add(worker);
        }
        await Promise.allSettled(inFlight);
        if (failed) {
            throw firstError;
        }
        return input.state.changed;
    }
    catch (error) {
        await Promise.allSettled(inFlight);
        await flushFileResultsAfterWorkerFailure(input.fileResultWriter, error);
        throw error;
    }
}
async function flushFileResultsAfterWorkerFailure(fileResultWriter, error) {
    try {
        await fileResultWriter.flush();
    }
    catch (flushError) {
        if (flushError === error) {
            throw error;
        }
        throw new AggregateError([error, flushError], "refresh failed and flushing file results failed");
    }
}
function canSkipRefresh(index, worktree, changed, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange) {
    return (index.metadata.status === "ready" &&
        !changed &&
        unchangedIndexShape(index, worktree, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange));
}
function unchangedIndexShape(index, worktree, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange) {
    return [
        !hasFileSetChange,
        !hasDiagnosticsChange,
        index.metadata.worktree === worktree,
        canReuseExistingRecords,
    ].every(Boolean);
}
function sameScannerOptions(metadata, options) {
    return (metadata.maxFileBytes === options.maxFileBytes &&
        sameStringArray(metadata.includeGlobs, options.includeGlobs) &&
        sameStringArray(metadata.excludeGlobs, options.excludeGlobs));
}
async function persistRefreshState(input) {
    input.index.files = input.state.nextFiles;
    input.index.chunks = input.lexicalIndex.chunks;
    input.index.symbols = input.state.nextSymbols;
    input.index.lexical = input.lexicalIndex.lexical;
    applyScannerMetadata(input.index, input.scannerInput);
    input.index.metadata.diagnostics = input.state.metadataDiagnostics;
    input.index.metadata.diagnosticDetails = input.state.metadataDiagnosticDetails;
    input.index.metadata.status = "ready";
    input.index.metadata.updatedAt = Date.now();
    await persistRefreshedIndex(input);
}
async function persistRefreshedIndex(input) {
    const run = input.run() ?? (input.runStore ? await input.ensureRun() : undefined);
    if (run && input.runStore) {
        await input.runStore.activateRun(run.runId, input.index);
        return;
    }
    await input.store.write(input.index);
}
async function processScannedFile(input) {
    input.signal?.throwIfAborted();
    const absolutePath = path.join(input.input.worktree, input.relativePath);
    const fileStat = await statFileForIndexing(absolutePath);
    const previousFile = input.index.files[input.relativePath];
    if (await reuseReadableStatFile(input, absolutePath, fileStat, previousFile)) {
        return input.state.changed;
    }
    if (await recordSkippedFile(input, absolutePath, fileStat)) {
        return input.state.changed;
    }
    const loaded = await loadTextFileForIndexing(absolutePath);
    input.signal?.throwIfAborted();
    if (await reuseLoadedFile(input, previousFile, loaded.fingerprint)) {
        return input.state.changed;
    }
    if (await reuseCompletedFileResult(input, loaded.fingerprint)) {
        return true;
    }
    await indexFile({ ...input, absolutePath, currentFingerprint: loaded.fingerprint, fileStat, text: loaded.text });
    return true;
}
async function reuseReadableStatFile(input, absolutePath, fileStat, previousFile) {
    if (!fileStat || fileStat.sizeBytes > input.input.options.maxFileBytes) {
        return false;
    }
    const canRead = await canReadFile(absolutePath);
    if (canRead && !statIsOlderThanIndex(fileStat, input.index.metadata.updatedAt)) {
        return false;
    }
    if (!(previousFile &&
        canReuseFileWithStat(input.index, input.state.symbolsByFilePath, previousFile, input.relativePath, fileStat, input.state.canReuseExistingRecords))) {
        return false;
    }
    await reuseScannedFile(input, previousFile);
    return true;
}
async function recordSkippedFile(input, absolutePath, fileStat) {
    const skipDiagnostic = await skipFileDiagnostic(input.relativePath, absolutePath, fileStat, input.input.options.maxFileBytes);
    if (!skipDiagnostic) {
        return false;
    }
    input.state.metadataDiagnostics.push(skipDiagnostic.message);
    input.state.metadataDiagnosticDetails.push(skipDiagnostic);
    return true;
}
async function reuseLoadedFile(input, previousFile, currentFingerprint) {
    if (!(previousFile &&
        canReuseFile(input.index, input.state.symbolsByFilePath, previousFile, input.relativePath, currentFingerprint, input.state.canReuseExistingRecords))) {
        return false;
    }
    await reuseScannedFile(input, previousFile);
    return true;
}
async function reuseCompletedFileResult(input, currentFingerprint) {
    const activeRun = await input.ensureRun();
    await flushQueuedReusedFileResults(input);
    const completed = activeRun
        ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
        : undefined;
    if (!(completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint))) {
        return false;
    }
    reuseCompletedFileRecords(completed, input.state);
    return true;
}
async function reuseScannedFile(input, previousFile) {
    const reused = reuseFileRecords(input.index, previousFile, input.state);
    if (!input.runStore) {
        return;
    }
    if (input.run()) {
        await input.fileResultWriter.add(reused);
        return;
    }
    input.state.reusedFileResults.push(reused);
    if (input.state.reusedFileResults.length >= MAX_QUEUED_REUSED_FILE_RESULTS) {
        await flushQueuedReusedFileResults(input);
    }
}
function reuseFileRecords(index, file, state) {
    state.nextFiles[file.path] = file;
    const chunks = {};
    for (const chunkId of file.chunkIds) {
        if (index.chunks[chunkId]) {
            state.nextChunks[chunkId] = index.chunks[chunkId];
            chunks[chunkId] = index.chunks[chunkId];
        }
    }
    const symbols = {};
    const referencedSymbolIds = referencedSymbolsForReusedChunks(index, file.path, chunks);
    for (const symbolId of referencedSymbolIds) {
        const symbol = index.symbols[symbolId];
        if (symbol) {
            const retainedSymbol = retainedSymbolRecord(index, symbol, referencedSymbolIds);
            state.nextSymbols[retainedSymbol.id] = retainedSymbol;
            symbols[retainedSymbol.id] = retainedSymbol;
        }
    }
    if (reusedSymbolsChanged(state.symbolsByFilePath.get(file.path) ?? [], Object.values(symbols))) {
        state.reusedRecordsChanged = true;
    }
    return { file, chunks, symbols };
}
function reusedSymbolsChanged(originalSymbols, retainedSymbols) {
    return (stableStringify(symbolsForComparison(originalSymbols)) !== stableStringify(symbolsForComparison(retainedSymbols)));
}
function symbolsForComparison(symbols) {
    return [...symbols].sort((left, right) => left.id.localeCompare(right.id));
}
function referencedSymbolsForReusedChunks(index, filePath, chunks) {
    const referenced = new Set();
    const queue = Object.values(chunks).flatMap((chunk) => chunk.symbolIds);
    while (queue.length > 0) {
        const symbolId = queue.shift();
        if (!symbolId) {
            continue;
        }
        if (referenced.has(symbolId) || !validSymbolId(index, symbolId, filePath)) {
            continue;
        }
        referenced.add(symbolId);
        const symbol = index.symbols[symbolId];
        if (symbol.parentSymbolId) {
            queue.push(symbol.parentSymbolId);
        }
    }
    return referenced;
}
function retainedSymbolRecord(index, symbol, retainedSymbolIds) {
    return {
        ...symbol,
        childSymbolIds: symbol.childSymbolIds.filter((id) => retainedSymbolIds.has(id) && index.symbols[id]?.parentSymbolId === symbol.id),
    };
}
async function flushQueuedReusedFileResults(input) {
    if (input.state.reusedFileResults.length === 0 || !input.runStore) {
        return;
    }
    await input.ensureRun();
    const queued = input.state.reusedFileResults.splice(0);
    for (const fileResult of queued) {
        await input.fileResultWriter.add(fileResult);
    }
    await input.fileResultWriter.flush();
}
function completedFileResult(runStore, runId, relativePath, currentFingerprint) {
    return runStore?.getCompletedFile(runId, relativePath, currentFingerprint);
}
function canReuseCompletedFile(index, completed, relativePath, currentFingerprint) {
    const completedIndex = {
        ...index,
        files: { [relativePath]: completed.file },
        chunks: completed.chunks,
        symbols: completed.symbols,
    };
    return canReuseFile(completedIndex, symbolsByFilePath(completed.symbols), completed.file, relativePath, currentFingerprint, true);
}
function reuseCompletedFileRecords(completed, state) {
    state.nextFiles[completed.file.path] = completed.file;
    Object.assign(state.nextChunks, completed.chunks);
    Object.assign(state.nextSymbols, completed.symbols);
}
async function indexFile(input) {
    const sourceIndex = createSourceIndex(input.text);
    const parsed = await input.input.parse(input.absolutePath, input.text).catch((error) => ({
        language: "text",
        root: undefined,
        diagnostic: String(error),
    }));
    input.signal?.throwIfAborted();
    const language = parsed.language;
    const root = parsed.root;
    const rawChunks = rawChunksForParsedFile(input, sourceIndex, language, root);
    const symbols = symbolsForParsedFile(input, sourceIndex, root);
    const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]));
    const chunks = attachTopology(assignSymbolsToChunks(rawChunks, symbolsById), symbolsById);
    const fileDiagnostics = "diagnostic" in parsed ? [String(parsed.diagnostic)] : [];
    const fileChunks = await embedChunks({ ...input, parsed: { language }, chunks, symbolsById, fileDiagnostics });
    await recordIndexedFile(input, language, symbols, chunks, fileChunks, fileDiagnostics);
}
function rawChunksForParsedFile(input, sourceIndex, language, root) {
    return root
        ? castChunks({
            filePath: input.relativePath,
            language,
            source: input.text,
            sourceIndex,
            root,
            maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
            chunking: input.input.options.chunking,
        })
        : fallbackChunks({
            filePath: input.relativePath,
            language,
            text: input.text,
            maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
            sourceIndex,
        });
}
function symbolsForParsedFile(input, sourceIndex, root) {
    return root
        ? extractSymbols({ filePath: input.relativePath, source: input.text, sourceIndex, nodes: root.children })
        : [];
}
function recordIndexedFile(input, language, symbols, chunks, fileChunks, fileDiagnostics) {
    Object.assign(input.state.nextChunks, fileChunks);
    for (const symbol of symbols) {
        input.state.nextSymbols[symbol.id] = symbol;
    }
    const fileRecord = indexedFileRecord(input, language, chunks, fileDiagnostics);
    input.state.nextFiles[input.relativePath] = fileRecord;
    return input.fileResultWriter.add({
        file: fileRecord,
        chunks: fileChunks,
        symbols: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
    });
}
function indexedFileRecord(input, language, chunks, fileDiagnostics) {
    return {
        path: input.relativePath,
        language,
        fingerprint: input.currentFingerprint,
        sizeBytes: input.fileStat?.sizeBytes,
        mtimeMs: input.fileStat?.mtimeMs,
        ctimeMs: input.fileStat?.ctimeMs,
        chunkIds: chunks.map((chunk) => chunk.id),
        diagnostics: fileDiagnostics,
    };
}
function createFileResultWriter(input) {
    const pending = [];
    let writeChain = Promise.resolve();
    const enqueue = (batch) => {
        writeChain = writeChain.then(async () => {
            const run = input.run();
            const runStore = input.runStore;
            if (!run) {
                return;
            }
            if (!runStore) {
                return;
            }
            if (hasBatchRunStore(runStore)) {
                await runStore.writeFileResults(run.runId, batch);
                return;
            }
            for (const fileResult of batch) {
                await runStore.writeFileResult(run.runId, fileResult);
            }
        });
        return writeChain;
    };
    const flushPending = () => {
        if (pending.length === 0) {
            return writeChain;
        }
        return enqueue(pending.splice(0, pending.length));
    };
    return {
        add(fileResult) {
            const runStore = input.runStore;
            if (!runStore) {
                return Promise.resolve();
            }
            const run = input.run();
            if (!run) {
                return Promise.resolve();
            }
            if (!hasBatchRunStore(runStore)) {
                return enqueue([fileResult]);
            }
            pending.push(fileResult);
            return pending.length >= DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE ? flushPending() : writeChain;
        },
        flush() {
            return flushPending();
        },
    };
}
function createEmbeddingBatcher(input, signal) {
    const batchSize = Math.max(1, input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
    const maxOutstanding = Math.max(1, input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY);
    const queue = [];
    const outstanding = new Set();
    let scheduled = false;
    const rejectQueued = () => {
        const error = signal?.reason ?? new Error("This operation was aborted");
        for (const item of queue.splice(0)) {
            item.reject(error);
        }
    };
    const flush = () => {
        scheduled = false;
        if (signal?.aborted) {
            rejectQueued();
            return;
        }
        if (queue.length === 0 || outstanding.size >= maxOutstanding) {
            return;
        }
        const batch = queue.splice(0, batchSize);
        const run = embedPendingBatch(input, batch, signal).finally(() => {
            outstanding.delete(run);
            if (queue.length > 0) {
                scheduleFlush();
            }
        });
        outstanding.add(run);
    };
    const scheduleFlush = () => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        setTimeout(flush, 0);
    };
    return {
        embed(text) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(signal.reason);
                    return;
                }
                queue.push({ text, resolve, reject });
                if (queue.length >= batchSize) {
                    flush();
                    return;
                }
                scheduleFlush();
            });
        },
        async drain() {
            while (queue.length > 0 || outstanding.size > 0) {
                if (signal?.aborted) {
                    rejectQueued();
                    signal.throwIfAborted();
                }
                flush();
                await Promise.all(Array.from(outstanding));
            }
        },
    };
}
async function embedPendingBatch(input, batch, signal) {
    const errorResult = (error) => ({
        embeddingError: error instanceof Error ? error.message : String(error),
    });
    if (signal?.aborted) {
        for (const item of batch) {
            item.reject(signal.reason);
        }
        return;
    }
    if (input.embedBatch) {
        await Promise.resolve()
            .then(() => input.embedBatch?.(batch.map((item) => item.text), signal) ?? [])
            .then((embeddings) => {
            for (const [index, item] of batch.entries()) {
                item.resolve(embeddings[index]
                    ? { embedding: embeddings[index] }
                    : { embeddingError: "embedding batch response omitted this input" });
            }
        })
            .catch((error) => {
            const result = errorResult(error);
            for (const item of batch) {
                item.resolve(result);
            }
        });
        return;
    }
    await Promise.all(batch.map(async (item) => {
        const result = await Promise.resolve()
            .then(() => input.embed(item.text, signal))
            .then((embedding) => ({ embedding }))
            .catch(errorResult);
        item.resolve(result);
    }));
}
async function embedChunks(input) {
    const fileChunks = {};
    const embeddedChunks = new Array(input.chunks.length);
    const concurrency = Math.max(1, input.input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY) *
        Math.max(1, input.input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
    await mapIndexesWithConcurrency(input.chunks.length, concurrency, async (index) => {
        const chunk = input.chunks[index];
        if (!chunk) {
            return;
        }
        embeddedChunks[index] = {
            chunk,
            embedded: await input.embeddingBatcher.embed(embeddingText(input.relativePath, input.parsed.language, chunk, input.symbolsById, input.input.options.chunking.expansion)),
        };
    });
    for (const { chunk, embedded } of embeddedChunks) {
        if ("embeddingError" in embedded) {
            input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`);
        }
        fileChunks[chunk.id] = { ...chunk, ...embedded };
    }
    return fileChunks;
}
async function mapIndexesWithConcurrency(length, concurrency, worker) {
    let next = 0;
    let failed = false;
    let firstError;
    const workers = Array.from({ length: Math.min(concurrency, length) }, async () => {
        while (!failed && next < length) {
            const index = next;
            next += 1;
            try {
                await worker(index);
            }
            catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    });
    await Promise.allSettled(workers);
    if (failed) {
        throw firstError;
    }
}
function hasRunStore(store) {
    return Boolean(store.beginIndexRun && store.getCompletedFile && store.writeFileResult && store.activateRun);
}
function hasBatchRunStore(store) {
    return Boolean(store.writeFileResults);
}
function indexRunConfigHash(index, worktree, options) {
    return stableHash({
        schemaVersion: index.metadata.schemaVersion,
        worktree,
        embeddingModel: index.metadata.embeddingModel,
        embeddingDimensions: index.metadata.embeddingDimensions,
        includeGlobs: options.includeGlobs,
        excludeGlobs: options.excludeGlobs,
        maxFileBytes: options.maxFileBytes,
        maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
        chunking: options.chunking,
    });
}
function stableHash(value) {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
async function skipFileDiagnostic(relativePath, filePath, fileStat, maxFileBytes) {
    if (!fileStat) {
        return;
    }
    if (fileStat.sizeBytes > maxFileBytes) {
        return {
            code: "index.skipped_file",
            message: `${relativePath}: skipped file over maxFileBytes (${fileStat.sizeBytes} > ${maxFileBytes})`,
            filePath: relativePath,
        };
    }
    const sample = new Uint8Array((await readFile(filePath)).subarray(0, Math.min(fileStat.sizeBytes, BINARY_SAMPLE_BYTES)));
    if (isProbablyBinary(sample)) {
        return { code: "index.skipped_file", message: `${relativePath}: skipped binary file`, filePath: relativePath };
    }
}
function isProbablyBinary(bytes) {
    if (bytes.length === 0) {
        return false;
    }
    let suspicious = 0;
    for (const byte of bytes) {
        if (byte === BYTE_NUL) {
            return true;
        }
        if (byte < CONTROL_BYTE_LIMIT && !isTextControlByte(byte)) {
            suspicious++;
        }
    }
    return suspicious / bytes.length > BINARY_CONTROL_RATIO;
}
function isTextControlByte(byte) {
    return TEXT_CONTROL_BYTES.has(byte);
}
const TEXT_CONTROL_BYTES = new Set([BYTE_BACKSPACE, BYTE_TAB, BYTE_LINE_FEED, BYTE_FORM_FEED, BYTE_CARRIAGE_RETURN]);
function symbolsByFilePath(symbols) {
    const grouped = new Map();
    for (const symbol of Object.values(symbols)) {
        const symbolsForFile = grouped.get(symbol.filePath);
        if (symbolsForFile) {
            symbolsForFile.push(symbol);
        }
        else {
            grouped.set(symbol.filePath, [symbol]);
        }
    }
    return grouped;
}
function canReuseFile(index, groupedSymbols, file, relativePath, fingerprint, canReuseExistingRecords) {
    if (!canReuseExistingRecords || file?.path !== relativePath || file.fingerprint !== fingerprint) {
        return false;
    }
    return canReuseFileRecords(index, groupedSymbols, file, relativePath);
}
function canReuseFileWithStat(index, groupedSymbols, file, relativePath, fileStat, canReuseExistingRecords) {
    if (!canReuseExistingRecords ||
        file?.path !== relativePath ||
        file.sizeBytes !== fileStat.sizeBytes ||
        file.mtimeMs !== fileStat.mtimeMs ||
        file.ctimeMs !== fileStat.ctimeMs) {
        return false;
    }
    return canReuseFileRecords(index, groupedSymbols, file, relativePath);
}
function canReuseFileRecords(index, groupedSymbols, file, relativePath) {
    const chunks = file.chunkIds.map((id) => ({ id, chunk: index.chunks[id] }));
    const chunkIds = new Set(file.chunkIds);
    if (chunks.some((entry) => !entry.chunk || entry.chunk.id !== entry.id)) {
        return false;
    }
    if (chunks.some((entry) => entry.chunk.filePath !== relativePath ||
        entry.chunk.language !== file.language ||
        entry.chunk.text.length === 0 ||
        !entry.chunk.embedding ||
        entry.chunk.embeddingError ||
        entry.chunk.symbolIds.some((id) => index.symbols[id]?.id !== id || index.symbols[id]?.filePath !== file.path) ||
        hasDanglingChunkReference(index, entry.chunk, chunkIds))) {
        return false;
    }
    return (groupedSymbols.get(file.path) ?? []).every((symbol) => validSymbolRecord(index, symbol, file.path));
}
function validSymbolRecord(index, symbol, filePath) {
    return validSymbolIdentity(index, symbol, filePath) && validSymbolRelations(index, symbol, filePath);
}
function validSymbolIdentity(index, symbol, filePath) {
    return index.symbols[symbol.id]?.id === symbol.id && index.symbols[symbol.id]?.filePath === filePath;
}
function validSymbolRelations(index, symbol, filePath) {
    return (validParentSymbol(index, symbol, filePath) &&
        symbol.childSymbolIds.every((id) => validSymbolId(index, id, filePath)));
}
function validParentSymbol(index, symbol, filePath) {
    return !symbol.parentSymbolId || validSymbolId(index, symbol.parentSymbolId, filePath);
}
function validSymbolId(index, id, filePath) {
    return index.symbols[id]?.id === id && index.symbols[id]?.filePath === filePath;
}
function sameChunkingOptions(left, right) {
    return (left?.overlap === right.overlap &&
        left.expansion === right.expansion &&
        left.minSemanticNonWhitespaceChars === right.minSemanticNonWhitespaceChars);
}
function sameStringArray(left, right) {
    if (!left) {
        return false;
    }
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function hasDanglingChunkReference(index, chunk, chunkIds) {
    return referencedChunkIds(chunk).some((id) => !validChunkReference(index, chunkIds, id));
}
function referencedChunkIds(chunk) {
    return [chunk.parentChunkId, chunk.previousSiblingChunkId, chunk.nextSiblingChunkId, ...chunk.childChunkIds].filter((id) => Boolean(id));
}
function validChunkReference(index, chunkIds, id) {
    return chunkIds.has(id) && Boolean(index.chunks[id]);
}
function embeddingText(filePath, language, chunk, symbols, expansion) {
    const fields = [`path: ${filePath}`, `language: ${language}`];
    if (expansion) {
        fields.push(`chunk:\nkind: ${chunk.kind}\nrange: ${chunk.range.lineStart}-${chunk.range.lineEnd}`);
    }
    fields.push(`symbols:\n${chunk.symbolIds
        .map((id) => symbols[id])
        .filter((symbol) => symbol)
        .map((symbol) => `${symbol.kind} ${symbol.name}`)
        .join("\n")}`);
    fields.push(`text:\n${chunk.text}`);
    return fields.join("\n");
}
async function shouldIndexSingleFile(input, relativePath) {
    const predicates = createScanPredicates(input.options.includeGlobs, input.options.excludeGlobs);
    return (predicates.includes(relativePath) &&
        !predicates.excludes(relativePath) &&
        !hasExcludedDirectoryAncestor(relativePath, predicates) &&
        !hasDefaultIgnoredPathPart(relativePath) &&
        !(await hasSymlinkPathComponent(input.worktree, relativePath)) &&
        !(await isGitignoredPath(input.worktree, relativePath)));
}
function hasExcludedDirectoryAncestor(relativePath, predicates) {
    return ancestorDirectories(relativePath).some((directory) => predicates.excludesDirectory(directory));
}
function ancestorDirectories(relativePath) {
    const dirname = path.dirname(relativePath);
    if (dirname === ".") {
        return [];
    }
    const segments = dirname.split(path.sep);
    return segments.map((_, index) => segments.slice(0, index + 1).join(path.sep));
}
async function hasSymlinkPathComponent(root, relativePath) {
    for (const componentPath of pathComponentPaths(relativePath)) {
        if (await isSymlinkPath(root, componentPath)) {
            return true;
        }
    }
    return false;
}
function pathComponentPaths(relativePath) {
    const parts = relativePath.split(path.sep).filter(Boolean);
    return parts.map((_, index) => parts.slice(0, index + 1).join(path.sep));
}
async function isSymlinkPath(root, relativePath) {
    try {
        return (await lstat(path.join(root, relativePath))).isSymbolicLink();
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
function hasDefaultIgnoredPathPart(relativePath) {
    return relativePath.split(path.sep).some((part) => DEFAULT_IGNORED_DIRECTORIES.has(part));
}
async function isGitignoredPath(root, relativePath) {
    const gitignores = [];
    const dirname = path.dirname(relativePath);
    const segments = dirname === "." ? [] : dirname.split(path.sep);
    for (let index = 0; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join(path.sep);
        const localGitignore = await loadGitignore(root, prefix);
        if (localGitignore) {
            gitignores.push(localGitignore);
        }
    }
    return isGitignored(relativePath, gitignores);
}
function worktreeRelativePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return;
    }
    return relative;
}
async function* scanFiles(root, includeGlobs, excludeGlobs) {
    const predicates = createScanPredicates(includeGlobs, excludeGlobs);
    for await (const file of walk(root, predicates)) {
        if (predicates.includes(file) && !predicates.excludes(file)) {
            yield file;
        }
    }
}
function createScanPredicates(includeGlobs, excludeGlobs) {
    const includes = includeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }));
    const excludes = excludeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }));
    const directoryExcludes = excludeGlobs
        .filter((pattern) => canPruneDirectoryForExclude(pattern))
        .map((pattern) => new Minimatch(pattern, { dot: true }));
    return {
        includes: (filePath) => includes.some((matcher) => matcher.match(filePath)),
        excludes: (filePath) => excludes.some((matcher) => matcher.match(filePath)),
        excludesDirectory: (relativePath) => {
            const globPath = toGitignorePath(relativePath);
            return directoryExcludes.some((matcher) => matcher.match(globPath) || matcher.match(`${globPath}/`));
        },
    };
}
function canPruneDirectoryForExclude(pattern) {
    const normalizedPattern = pattern.replaceAll("\\", "/").replace(TRAILING_SLASHES, "");
    if (normalizedPattern.endsWith("/**")) {
        return true;
    }
    return !new Minimatch(pattern, { dot: true }).hasMagic();
}
async function loadGitignore(root, prefix) {
    const matcher = ignore();
    try {
        matcher.add(await readFile(path.join(root, prefix, ".gitignore"), "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
        return;
    }
    return { base: prefix, matcher };
}
async function* walk(root, predicates) {
    const queue = [{ prefix: "", gitignores: [] }];
    while (queue.length > 0) {
        const directory = queue.shift();
        if (!directory) {
            continue;
        }
        for (const entry of await walkEntries(root, directory)) {
            const relative = path.join(directory.prefix, entry.name);
            if (shouldSkipWalkEntry(entry, relative, entry.gitignores)) {
                continue;
            }
            if (entry.isDirectory()) {
                enqueueWalkDirectory(queue, relative, entry.gitignores, predicates);
                continue;
            }
            yield relative;
        }
    }
}
async function walkEntries(root, directory) {
    const entries = await readdir(path.join(root, directory.prefix), { withFileTypes: true });
    const localGitignore = await loadGitignore(root, directory.prefix);
    const gitignores = localGitignore ? [...directory.gitignores, localGitignore] : directory.gitignores;
    return entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => Object.assign(entry, { gitignores }));
}
function shouldSkipWalkEntry(entry, relative, gitignores) {
    return DEFAULT_IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink() || isGitignored(relative, gitignores);
}
function enqueueWalkDirectory(queue, relative, gitignores, predicates) {
    if (!predicates.excludesDirectory(relative)) {
        queue.push({ prefix: relative, gitignores });
    }
}
function isGitignored(relativePath, gitignores) {
    return gitignores.some(({ base, matcher }) => {
        const relativeToBase = base ? path.relative(base, relativePath) : relativePath;
        return relativeToBase && !relativeToBase.startsWith("..") && !path.isAbsolute(relativeToBase)
            ? matcher.ignores(toGitignorePath(relativeToBase))
            : false;
    });
}
function toGitignorePath(relativePath) {
    return relativePath.split(path.sep).join("/");
}
async function loadTextFileForIndexing(filePath) {
    const bytes = await readFile(filePath);
    return {
        fingerprint: fingerprintBytes(bytes),
        text: new TextDecoder().decode(bytes),
    };
}
async function statFileForIndexing(filePath) {
    try {
        const fileStat = await stat(filePath);
        return { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }
}
async function canReadFile(filePath) {
    try {
        await access(filePath, constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
function statIsOlderThanIndex(fileStat, updatedAt) {
    return (updatedAt - fileStat.mtimeMs >= STAT_FAST_PATH_SETTLE_MS && updatedAt - fileStat.ctimeMs >= STAT_FAST_PATH_SETTLE_MS);
}
function fingerprintBytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
