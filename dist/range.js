const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WHITESPACE_PATTERN = /\s/;
export function nonWhitespaceLength(text) {
    return [...text].filter((character) => !WHITESPACE_PATTERN.test(character)).length;
}
export function rangeForSlice(source, byteStart, byteEnd) {
    return rangeForIndexedSlice(createSourceIndex(source), byteStart, byteEnd);
}
export function stableChunkId(filePath, byteStart, byteEnd) {
    return `${filePath}:${byteStart}:${byteEnd}`;
}
export function textForByteSlice(source, byteStart, byteEnd) {
    return textForIndexedByteSlice(createSourceIndex(source), byteStart, byteEnd);
}
export function createSourceIndex(source) {
    const bytes = encoder.encode(source);
    const byteToStringOffset = [0];
    const lineStartByteOffsets = [0];
    const nonWhitespacePrefix = [0];
    let sourceByteOffset = 0;
    let offset = 0;
    let nonWhitespaceCount = 0;
    for (const character of source) {
        const characterBytes = encoder.encode(character).length;
        const nextOffset = offset + character.length;
        const nextNonWhitespaceCount = WHITESPACE_PATTERN.test(character) ? nonWhitespaceCount : nonWhitespaceCount + 1;
        for (let index = 1; index <= characterBytes; index++) {
            byteToStringOffset[sourceByteOffset + index] = nextOffset;
            nonWhitespacePrefix[sourceByteOffset + index] = nextNonWhitespaceCount;
        }
        if (character === "\n") {
            lineStartByteOffsets.push(sourceByteOffset + characterBytes);
        }
        sourceByteOffset += characterBytes;
        offset = nextOffset;
        nonWhitespaceCount = nextNonWhitespaceCount;
    }
    return { source, bytes, byteToStringOffset, lineStartByteOffsets, nonWhitespacePrefix };
}
export function textForIndexedByteSlice(index, byteStart, byteEnd) {
    return decoder.decode(index.bytes.slice(byteStart, byteEnd));
}
export function rangeForIndexedSlice(index, byteStart, byteEnd) {
    const slice = index.source.slice(stringOffsetForByteOffset(index, byteStart), stringOffsetForByteOffset(index, byteEnd));
    const lineStart = lineForByteOffset(index, byteStart);
    return {
        byteStart,
        byteEnd,
        lineStart,
        lineEnd: lineStart + lineSpan(slice) - 1,
    };
}
export function nonWhitespaceLengthForIndexedSlice(index, byteStart, byteEnd) {
    return index.nonWhitespacePrefix[byteEnd] - index.nonWhitespacePrefix[byteStart];
}
function stringOffsetForByteOffset(index, byteOffset) {
    return index.byteToStringOffset[byteOffset] ?? index.source.length;
}
function lineForByteOffset(index, byteOffset) {
    let low = 0;
    let high = index.lineStartByteOffsets.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (index.lineStartByteOffsets[middle] <= byteOffset) {
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    return high + 1;
}
function lineSpan(slice) {
    const measured = slice.endsWith("\n") ? slice.slice(0, -1) : slice;
    return measured.split("\n").length;
}
