import { INDEX_SCHEMA_VERSION } from "./store-index.js"
import type { CastIndex, ChunkingOptions } from "./types.js"

const INDEX_STATUSES: readonly unknown[] = ["empty", "indexing", "ready", "stale", "error"]
const CHUNK_KINDS: readonly unknown[] = ["file", "class", "function", "method", "block", "fallback"]
const SYMBOL_KINDS: readonly unknown[] = ["module", "class", "function", "method", "interface"]

function isCastIndex(value: unknown): value is CastIndex {
  return (
    isObject(value) &&
    isIndexMetadata(value.metadata) &&
    isRecordMap(value.files, isFileRecord) &&
    isRecordMap(value.chunks, isChunkRecord) &&
    isRecordMap(value.symbols, isSymbolRecord) &&
    (value.lexical === undefined || isLexicalIndex(value.lexical))
  )
}

function isIndexMetadata(value: unknown) {
  if (!isObject(value)) {
    return false
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
  ])
}

function isChunkingOptions(value: unknown): value is ChunkingOptions {
  return (
    isObject(value) &&
    isNonnegativeNumber(value.overlap) &&
    Number.isInteger(value.overlap) &&
    typeof value.expansion === "boolean" &&
    typeof value.minSemanticNonWhitespaceChars === "number" &&
    Number.isInteger(value.minSemanticNonWhitespaceChars) &&
    value.minSemanticNonWhitespaceChars > 0
  )
}

function isFileRecord(value: unknown) {
  return isObject(value) && hasFileRecordStrings(value) && hasFileRecordMetadata(value) && hasFileRecordArrays(value)
}

function hasFileRecordStrings(value: Record<string, unknown>) {
  return typeof value.path === "string" && typeof value.language === "string" && typeof value.fingerprint === "string"
}

function hasFileRecordMetadata(value: Record<string, unknown>) {
  return (
    isOptionalNonnegativeNumber(value.sizeBytes) &&
    isOptionalNonnegativeNumber(value.mtimeMs) &&
    isOptionalNonnegativeNumber(value.ctimeMs)
  )
}

function hasFileRecordArrays(value: Record<string, unknown>) {
  return isStringArray(value.chunkIds) && isStringArray(value.diagnostics)
}

function isChunkRecord(value: unknown) {
  if (!isObject(value)) {
    return false
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
  ])
}

function isLexicalIndex(value: unknown) {
  return (
    isObject(value) &&
    isNonnegativeNumber(value.documentCount) &&
    isNonnegativeNumber(value.averageDocumentLength) &&
    isRecordMap(value.documentFrequencies, isNonnegativeNumber)
  )
}

function isChunkLexicalStats(value: unknown) {
  return isObject(value) && isNonnegativeNumber(value.length) && isRecordMap(value.termFrequencies, isNonnegativeNumber)
}

function isSymbolRecord(value: unknown) {
  if (!isObject(value)) {
    return false
  }
  return allPass([
    typeof value.id === "string",
    typeof value.name === "string",
    SYMBOL_KINDS.includes(value.kind),
    typeof value.filePath === "string",
    isSourceRange(value.range),
    isOptionalString(value.parentSymbolId),
    isStringArray(value.childSymbolIds),
  ])
}

function isSourceRange(value: unknown) {
  return (
    isObject(value) &&
    typeof value.byteStart === "number" &&
    typeof value.byteEnd === "number" &&
    typeof value.lineStart === "number" &&
    typeof value.lineEnd === "number"
  )
}

function isRecordMap(value: unknown, isValue: (value: unknown) => boolean) {
  return isObject(value) && Object.values(value).every(isValue)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isNumberArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
}

function isOptionalNumberArray(value: unknown) {
  return value === undefined || isNumberArray(value)
}

function isNonnegativeNumber(value: unknown) {
  return typeof value === "number" && value >= 0
}

function isOptionalNonnegativeNumber(value: unknown) {
  return value === undefined || isNonnegativeNumber(value)
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isOptionalNumber(value: unknown) {
  return value === undefined || typeof value === "number"
}

function allPass(checks: boolean[]) {
  return checks.every(Boolean)
}

export { isCastIndex }
