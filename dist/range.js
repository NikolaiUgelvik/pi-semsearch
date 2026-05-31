const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WHITESPACE_PATTERN = /\s/;
export function nonWhitespaceLength(text) {
    return [...text].filter((character) => !WHITESPACE_PATTERN.test(character)).length;
}
export function rangeForSlice(source, byteStart, byteEnd) {
    const before = source.slice(0, stringOffsetForByteOffset(source, byteStart));
    const slice = source.slice(stringOffsetForByteOffset(source, byteStart), stringOffsetForByteOffset(source, byteEnd));
    return {
        byteStart,
        byteEnd,
        lineStart: before.split("\n").length,
        lineEnd: before.split("\n").length + lineSpan(slice) - 1,
    };
}
export function stableChunkId(filePath, byteStart, byteEnd) {
    return `${filePath}:${byteStart}:${byteEnd}`;
}
export function textForByteSlice(source, byteStart, byteEnd) {
    return decoder.decode(encoder.encode(source).slice(byteStart, byteEnd));
}
function stringOffsetForByteOffset(source, byteOffset) {
    let bytes = 0;
    let offset = 0;
    for (const character of source) {
        if (bytes >= byteOffset) {
            return offset;
        }
        bytes += encoder.encode(character).length;
        offset += character.length;
    }
    return offset;
}
function lineSpan(slice) {
    const measured = slice.endsWith("\n") ? slice.slice(0, -1) : slice;
    return measured.split("\n").length;
}
