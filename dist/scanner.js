import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { castChunks } from "./cast.js";
import { fallbackChunks } from "./fallback.js";
import { buildLexicalIndex } from "./lexical.js";
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
const DEFAULT_FILE_CONCURRENCY = 4;
const DEFAULT_FILE_RESULT_WRITE_BATCH_SIZE = 32;
export function createIndexer(input) {
    return {
        async refresh() {
            const store = input.store;
            const index = await store.read();
            const initialStatus = index.metadata.status;
            const canReuseExistingRecords = index.metadata.maxChunkNonWhitespaceChars === input.options.maxChunkNonWhitespaceChars &&
                sameChunkingOptions(index.metadata.chunking, input.options.chunking);
            const runConfigHash = indexRunConfigHash(index, input.options);
            const runStore = hasRunStore(store) && initialStatus !== "ready" ? store : undefined;
            const files = await scanFiles(input.worktree, input.options.includeGlobs, input.options.excludeGlobs);
            const nextFiles = {};
            const nextChunks = {};
            const nextSymbols = {};
            const metadataDiagnostics = [];
            const embeddingBatcher = createEmbeddingBatcher(input);
            const fileResultWriter = createFileResultWriter({ runStore, run: () => run });
            let changed = false;
            let run;
            let runPromise;
            const markIndexing = () => {
                index.metadata.status = "indexing";
                index.metadata.worktree = input.worktree;
                index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars;
                index.metadata.chunking = input.options.chunking;
            };
            const ensureRun = async () => {
                if (!runStore) {
                    return;
                }
                if (run) {
                    return run;
                }
                if (!runPromise) {
                    markIndexing();
                    runPromise = runStore.beginIndexRun({ configHash: runConfigHash, metadata: index.metadata });
                }
                run = await runPromise;
                return run;
            };
            changed = await processScannedFiles({
                files,
                input,
                index,
                state: { nextFiles, nextChunks, nextSymbols, metadataDiagnostics, canReuseExistingRecords, changed },
                runStore,
                run: () => run,
                ensureRun,
                embeddingBatcher,
                fileResultWriter,
            });
            await embeddingBatcher.drain();
            await fileResultWriter.flush();
            metadataDiagnostics.sort();
            const lexicalIndex = buildLexicalIndex(nextChunks, nextSymbols);
            const hasFileSetChange = !sameStringArray(Object.keys(index.files).sort(), Object.keys(nextFiles).sort());
            const hasDiagnosticsChange = !sameStringArray(index.metadata.diagnostics, metadataDiagnostics);
            if (canSkipRefresh(index, input.worktree, changed, canReuseExistingRecords, hasFileSetChange, hasDiagnosticsChange)) {
                return index;
            }
            index.files = nextFiles;
            index.chunks = lexicalIndex.chunks;
            index.symbols = nextSymbols;
            index.lexical = lexicalIndex.lexical;
            index.metadata.worktree = input.worktree;
            index.metadata.maxChunkNonWhitespaceChars = input.options.maxChunkNonWhitespaceChars;
            index.metadata.chunking = input.options.chunking;
            index.metadata.diagnostics = metadataDiagnostics;
            index.metadata.status = "ready";
            index.metadata.updatedAt = Date.now();
            await persistRefreshedIndex({ index, store, runStore, run: () => run, ensureRun });
            return index;
        },
    };
}
async function processScannedFiles(input) {
    try {
        await mapWithConcurrency(input.files, DEFAULT_FILE_CONCURRENCY, async (relativePath) => {
            const nextChanged = await processScannedFile({ ...input, relativePath });
            input.state.changed = input.state.changed || nextChanged;
        });
        return input.state.changed;
    }
    catch (error) {
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
async function persistRefreshedIndex(input) {
    const run = input.run() ?? (input.runStore ? await input.ensureRun() : undefined);
    if (run && input.runStore) {
        await input.runStore.activateRun(run.runId, input.index);
        return;
    }
    await input.store.write(input.index);
}
async function processScannedFile(input) {
    const absolutePath = path.join(input.input.worktree, input.relativePath);
    const file = Bun.file(absolutePath);
    const skipDiagnostic = await skipFileDiagnostic(input.relativePath, file, input.input.options.maxFileBytes);
    if (skipDiagnostic) {
        input.state.metadataDiagnostics.push(skipDiagnostic);
        return input.state.changed;
    }
    const loaded = await loadTextFileForIndexing(absolutePath);
    const currentFingerprint = loaded.fingerprint;
    const previousFile = input.index.files[input.relativePath];
    if (canReuseFile(input.index, previousFile, input.relativePath, currentFingerprint, input.state.canReuseExistingRecords)) {
        reuseFileRecords(input.index, previousFile, input.state);
        return input.state.changed;
    }
    const activeRun = await input.ensureRun();
    const completed = activeRun
        ? await completedFileResult(input.runStore, activeRun.runId, input.relativePath, currentFingerprint)
        : undefined;
    if (completed && canReuseCompletedFile(input.index, completed, input.relativePath, currentFingerprint)) {
        reuseCompletedFileRecords(completed, input.state);
        return true;
    }
    await indexFile({ ...input, absolutePath, currentFingerprint, text: loaded.text });
    return true;
}
function reuseFileRecords(index, file, state) {
    state.nextFiles[file.path] = file;
    for (const chunkId of file.chunkIds) {
        if (index.chunks[chunkId]) {
            state.nextChunks[chunkId] = index.chunks[chunkId];
        }
    }
    for (const symbol of Object.values(index.symbols).filter((symbol) => symbol.filePath === file.path)) {
        state.nextSymbols[symbol.id] = symbol;
    }
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
    return canReuseFile(completedIndex, completed.file, relativePath, currentFingerprint, true);
}
function reuseCompletedFileRecords(completed, state) {
    state.nextFiles[completed.file.path] = completed.file;
    Object.assign(state.nextChunks, completed.chunks);
    Object.assign(state.nextSymbols, completed.symbols);
}
async function indexFile(input) {
    const parsed = await input.input.parse(input.absolutePath, input.text).catch((error) => ({
        language: "text",
        root: undefined,
        diagnostic: String(error),
    }));
    const rawChunks = parsed.root
        ? castChunks({
            filePath: input.relativePath,
            language: parsed.language,
            source: input.text,
            root: parsed.root,
            maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
            chunking: input.input.options.chunking,
        })
        : fallbackChunks({
            filePath: input.relativePath,
            language: parsed.language,
            text: input.text,
            maxNonWhitespaceChars: input.input.options.maxChunkNonWhitespaceChars,
        });
    const symbols = parsed.root
        ? extractSymbols({ filePath: input.relativePath, source: input.text, nodes: parsed.root.children })
        : [];
    const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]));
    const chunks = attachTopology(assignSymbolsToChunks(rawChunks, symbolsById), symbolsById);
    const fileDiagnostics = "diagnostic" in parsed ? [String(parsed.diagnostic)] : [];
    const fileChunks = await embedChunks({ ...input, parsed, chunks, symbolsById, fileDiagnostics });
    Object.assign(input.state.nextChunks, fileChunks);
    for (const symbol of symbols) {
        input.state.nextSymbols[symbol.id] = symbol;
    }
    const fileRecord = {
        path: input.relativePath,
        language: parsed.language,
        fingerprint: input.currentFingerprint,
        chunkIds: chunks.map((chunk) => chunk.id),
        diagnostics: fileDiagnostics,
    };
    input.state.nextFiles[input.relativePath] = fileRecord;
    await input.fileResultWriter.add({
        file: fileRecord,
        chunks: fileChunks,
        symbols: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
    });
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
function createEmbeddingBatcher(input) {
    const batchSize = Math.max(1, input.options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
    const queue = [];
    const outstanding = new Set();
    let scheduled = false;
    const flush = () => {
        scheduled = false;
        if (queue.length === 0) {
            return;
        }
        const batch = queue.splice(0, batchSize);
        const run = embedPendingBatch(input, batch).finally(() => {
            outstanding.delete(run);
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
            return new Promise((resolve) => {
                queue.push({ text, resolve });
                if (queue.length >= batchSize) {
                    flush();
                    return;
                }
                scheduleFlush();
            });
        },
        async drain() {
            while (queue.length > 0 || outstanding.size > 0) {
                flush();
                await Promise.all(Array.from(outstanding));
            }
        },
    };
}
async function embedPendingBatch(input, batch) {
    const errorResult = (error) => ({
        embeddingError: error instanceof Error ? error.message : String(error),
    });
    if (input.embedBatch) {
        await Promise.resolve()
            .then(() => input.embedBatch?.(batch.map((item) => item.text)) ?? [])
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
            .then(() => input.embed(item.text))
            .then((embedding) => ({ embedding }))
            .catch(errorResult);
        item.resolve(result);
    }));
}
async function embedChunks(input) {
    const fileChunks = {};
    const embeddedChunks = await Promise.all(input.chunks.map(async (chunk) => {
        const embedded = await input.embeddingBatcher.embed(embeddingText(input.relativePath, input.parsed.language, chunk, input.symbolsById, input.input.options.chunking.expansion));
        return { chunk, embedded };
    }));
    for (const { chunk, embedded } of embeddedChunks) {
        if ("embeddingError" in embedded) {
            input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`);
        }
        fileChunks[chunk.id] = { ...chunk, ...embedded };
    }
    return fileChunks;
}
function hasRunStore(store) {
    return Boolean(store.beginIndexRun && store.getCompletedFile && store.writeFileResult && store.activateRun);
}
function hasBatchRunStore(store) {
    return Boolean(store.writeFileResults);
}
function indexRunConfigHash(index, options) {
    return stableHash({
        schemaVersion: index.metadata.schemaVersion,
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
async function skipFileDiagnostic(relativePath, file, maxFileBytes) {
    if (file.size > maxFileBytes) {
        return `${relativePath}: skipped file over maxFileBytes (${file.size} > ${maxFileBytes})`;
    }
    const sample = new Uint8Array(await file.slice(0, Math.min(file.size, BINARY_SAMPLE_BYTES)).arrayBuffer());
    if (isProbablyBinary(sample)) {
        return `${relativePath}: skipped binary file`;
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
function canReuseFile(index, file, relativePath, fingerprint, canReuseExistingRecords) {
    if (!canReuseExistingRecords || file?.path !== relativePath || file.fingerprint !== fingerprint) {
        return false;
    }
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
    return Object.values(index.symbols)
        .filter((symbol) => symbol.filePath === file.path)
        .every((symbol) => validSymbolRecord(index, symbol, file.path));
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
        const lineEnd = chunk.text.endsWith("\n")
            ? Math.max(chunk.range.lineStart, chunk.range.lineEnd - 1)
            : chunk.range.lineEnd;
        fields.push(`chunk:\nkind: ${chunk.kind}\nrange: ${chunk.range.lineStart}-${lineEnd}`);
    }
    fields.push(`symbols:\n${chunk.symbolIds
        .map((id) => symbols[id])
        .filter((symbol) => symbol)
        .map((symbol) => `${symbol.kind} ${symbol.name}`)
        .join("\n")}`);
    fields.push(`text:\n${chunk.text}`);
    return fields.join("\n");
}
async function scanFiles(root, includeGlobs, excludeGlobs) {
    const files = await walk(root);
    return files.filter((file) => includeGlobs.some((pattern) => minimatch(file, pattern)) &&
        !excludeGlobs.some((pattern) => minimatch(file, pattern)));
}
async function mapWithConcurrency(items, concurrency, worker) {
    let next = 0;
    let failed = false;
    let firstError;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (!failed && next < items.length) {
            const item = items[next];
            next += 1;
            try {
                await worker(item);
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
async function walk(root, prefix = "", inheritedGitignores = []) {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
    const localGitignore = await loadGitignore(root, prefix);
    const gitignores = localGitignore ? [...inheritedGitignores, localGitignore] : inheritedGitignores;
    const ignored = new Set([".git", "node_modules", "dist", "build", ".cache"]);
    const nested = await Promise.all(entries
        .filter((entry) => {
        const relative = path.join(prefix, entry.name);
        return !(ignored.has(entry.name) || entry.isSymbolicLink() || isGitignored(relative, gitignores));
    })
        .map((entry) => {
        const relative = path.join(prefix, entry.name);
        return entry.isDirectory() ? walk(root, relative, gitignores) : Promise.resolve([relative]);
    }));
    return nested.flat();
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
    const bytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
    return {
        fingerprint: fingerprintBytes(bytes),
        text: new TextDecoder().decode(bytes),
    };
}
function fingerprintBytes(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
