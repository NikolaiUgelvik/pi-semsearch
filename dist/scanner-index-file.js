import { castChunks } from "./cast.js";
import { fallbackChunks } from "./fallback.js";
import { createSourceIndex } from "./range.js";
import { embedChunks } from "./scanner-batching.js";
import { assignSymbolsToChunks, attachTopology, extractSymbols } from "./topology.js";
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
export { indexFile };
