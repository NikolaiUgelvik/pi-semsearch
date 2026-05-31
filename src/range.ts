import type { SourceRange } from "./types.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const WHITESPACE_PATTERN = /\s/

export function nonWhitespaceLength(text: string) {
  return [...text].filter((character) => !WHITESPACE_PATTERN.test(character)).length
}

export function rangeForSlice(source: string, byteStart: number, byteEnd: number): SourceRange {
  const before = source.slice(0, stringOffsetForByteOffset(source, byteStart))
  const slice = source.slice(stringOffsetForByteOffset(source, byteStart), stringOffsetForByteOffset(source, byteEnd))
  return {
    byteStart,
    byteEnd,
    lineStart: before.split("\n").length,
    lineEnd: before.split("\n").length + lineSpan(slice) - 1,
  }
}

export function stableChunkId(filePath: string, byteStart: number, byteEnd: number) {
  return `${filePath}:${byteStart}:${byteEnd}`
}

export function textForByteSlice(source: string, byteStart: number, byteEnd: number) {
  return decoder.decode(encoder.encode(source).slice(byteStart, byteEnd))
}

function stringOffsetForByteOffset(source: string, byteOffset: number) {
  let bytes = 0
  let offset = 0

  for (const character of source) {
    if (bytes >= byteOffset) {
      return offset
    }
    bytes += encoder.encode(character).length
    offset += character.length
  }

  return offset
}

function lineSpan(slice: string) {
  const measured = slice.endsWith("\n") ? slice.slice(0, -1) : slice
  return measured.split("\n").length
}
