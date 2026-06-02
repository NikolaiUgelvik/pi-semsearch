import { createSourceIndex, nonWhitespaceLengthForIndexedSlice, rangeForIndexedSlice, stableChunkId, } from "./range.js";
const encoder = new TextEncoder();
const LINE_PATTERN = /.*(?:\n|$)/g;
const WHITESPACE_PATTERN = /\s/;
export function fallbackChunks(input) {
    const sourceIndex = input.sourceIndex ?? createSourceIndex(input.text);
    const byteOffset = input.byteOffset ?? 0;
    const chunks = [];
    let byteStart = byteOffset;
    let pending = "";
    let pendingStart = byteOffset;
    let pendingNonWhitespaceChars = 0;
    for (const line of input.text.matchAll(LINE_PATTERN)) {
        if (!line[0]) {
            continue;
        }
        for (const part of splitByNonWhitespaceBudget(line[0], input.maxNonWhitespaceChars)) {
            if (pending && pendingNonWhitespaceChars + part.nonWhitespaceChars > input.maxNonWhitespaceChars) {
                chunks.push(makeFallbackChunk(input.filePath, input.language, sourceIndex, pendingStart, byteStart, pending));
                pending = "";
                pendingStart = byteStart;
                pendingNonWhitespaceChars = 0;
            }
            pending += part.text;
            pendingNonWhitespaceChars += part.nonWhitespaceChars;
            byteStart += part.byteLength;
        }
    }
    if (pending) {
        chunks.push(makeFallbackChunk(input.filePath, input.language, sourceIndex, pendingStart, byteStart, pending));
    }
    return chunks.map((chunk, index) => ({
        ...chunk,
        previousSiblingChunkId: chunks[index - 1]?.id,
        nextSiblingChunkId: chunks[index + 1]?.id,
    }));
}
function makeFallbackChunk(filePath, language, sourceIndex, byteStart, byteEnd, text) {
    return {
        id: stableChunkId(filePath, byteStart, byteEnd),
        filePath,
        language,
        kind: "fallback",
        range: rangeForIndexedSlice(sourceIndex, byteStart, byteEnd),
        text,
        nonWhitespaceChars: nonWhitespaceLengthForIndexedSlice(sourceIndex, byteStart, byteEnd),
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
    };
}
function splitByNonWhitespaceBudget(text, maxNonWhitespaceChars) {
    const parts = [];
    let pending = "";
    let nonWhitespaceChars = 0;
    let byteLength = 0;
    for (const character of text) {
        if (pending && !WHITESPACE_PATTERN.test(character) && nonWhitespaceChars >= maxNonWhitespaceChars) {
            parts.push({ text: pending, nonWhitespaceChars, byteLength });
            pending = "";
            nonWhitespaceChars = 0;
            byteLength = 0;
        }
        pending += character;
        byteLength += encoder.encode(character).length;
        if (!WHITESPACE_PATTERN.test(character)) {
            nonWhitespaceChars++;
        }
    }
    if (pending) {
        parts.push({ text: pending, nonWhitespaceChars, byteLength });
    }
    return parts;
}
