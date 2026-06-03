import { INDEX_SCHEMA_VERSION } from "./store-index.js";
const INDEX_STATUSES = ["empty", "indexing", "ready", "stale", "error"];
const CHUNK_KINDS = ["file", "class", "function", "method", "block", "fallback"];
const SYMBOL_KINDS = ["module", "class", "function", "method", "interface"];
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
    return isObject(value) && hasFileRecordStrings(value) && hasFileRecordMetadata(value) && hasFileRecordArrays(value);
}
function hasFileRecordStrings(value) {
    return typeof value.path === "string" && typeof value.language === "string" && typeof value.fingerprint === "string";
}
function hasFileRecordMetadata(value) {
    return (isOptionalNonnegativeNumber(value.sizeBytes) &&
        isOptionalNonnegativeNumber(value.mtimeMs) &&
        isOptionalNonnegativeNumber(value.ctimeMs));
}
function hasFileRecordArrays(value) {
    return isStringArray(value.chunkIds) && isStringArray(value.diagnostics);
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
function isOptionalNonnegativeNumber(value) {
    return value === undefined || isNonnegativeNumber(value);
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
export { isCastIndex };
