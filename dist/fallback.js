import { nonWhitespaceLength, rangeForSlice, stableChunkId } from "./range.js";
const encoder = new TextEncoder();
const LINE_PATTERN = /.*(?:\n|$)/g;
const WHITESPACE_PATTERN = /\s/;
export function fallbackChunks(input) {
    const chunks = [];
    let byteStart = 0;
    let pending = "";
    let pendingStart = 0;
    for (const line of input.text.matchAll(LINE_PATTERN)) {
        if (!line[0]) {
            continue;
        }
        for (const part of splitByNonWhitespaceBudget(line[0], input.maxNonWhitespaceChars)) {
            if (pending && nonWhitespaceLength(pending + part) > input.maxNonWhitespaceChars) {
                chunks.push(makeFallbackChunk(input.filePath, input.language, input.text, pendingStart, byteStart, pending));
                pending = "";
                pendingStart = byteStart;
            }
            pending += part;
            byteStart += encoder.encode(part).length;
        }
    }
    if (pending) {
        chunks.push(makeFallbackChunk(input.filePath, input.language, input.text, pendingStart, byteStart, pending));
    }
    return chunks.map((chunk, index) => ({
        ...chunk,
        previousSiblingChunkId: chunks[index - 1]?.id,
        nextSiblingChunkId: chunks[index + 1]?.id,
    }));
}
function makeFallbackChunk(filePath, language, source, byteStart, byteEnd, text) {
    return {
        id: stableChunkId(filePath, byteStart, byteEnd),
        filePath,
        language,
        kind: "fallback",
        range: rangeForSlice(source, byteStart, byteEnd),
        text,
        nonWhitespaceChars: nonWhitespaceLength(text),
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
    };
}
function splitByNonWhitespaceBudget(text, maxNonWhitespaceChars) {
    const parts = [];
    let pending = "";
    let nonWhitespaceChars = 0;
    for (const character of text) {
        if (pending && !WHITESPACE_PATTERN.test(character) && nonWhitespaceChars >= maxNonWhitespaceChars) {
            parts.push(pending);
            pending = "";
            nonWhitespaceChars = 0;
        }
        pending += character;
        if (!WHITESPACE_PATTERN.test(character)) {
            nonWhitespaceChars++;
        }
    }
    if (pending) {
        parts.push(pending);
    }
    return parts;
}
