import type { SourceRange } from "./types.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const WHITESPACE_PATTERN = /\s/

export interface SourceIndex {
  source: string
  bytes: Uint8Array
  byteToStringOffset: number[]
  lineStartByteOffsets: number[]
  nonWhitespacePrefix: number[]
}

export function nonWhitespaceLength(text: string) {
  return [...text].filter((character) => !WHITESPACE_PATTERN.test(character)).length
}

export function rangeForSlice(source: string, byteStart: number, byteEnd: number): SourceRange {
  return rangeForIndexedSlice(createSourceIndex(source), byteStart, byteEnd)
}

export function stableChunkId(filePath: string, byteStart: number, byteEnd: number) {
  return `${filePath}:${byteStart}:${byteEnd}`
}

export function textForByteSlice(source: string, byteStart: number, byteEnd: number) {
  return textForIndexedByteSlice(createSourceIndex(source), byteStart, byteEnd)
}

export function createSourceIndex(source: string): SourceIndex {
  const bytes = encoder.encode(source)
  const byteToStringOffset: number[] = [0]
  const lineStartByteOffsets = [0]
  const nonWhitespacePrefix: number[] = [0]
  let sourceByteOffset = 0
  let offset = 0
  let nonWhitespaceCount = 0

  for (const character of source) {
    const characterBytes = encoder.encode(character).length
    const nextOffset = offset + character.length
    const nextNonWhitespaceCount = WHITESPACE_PATTERN.test(character) ? nonWhitespaceCount : nonWhitespaceCount + 1

    for (let index = 1; index <= characterBytes; index++) {
      byteToStringOffset[sourceByteOffset + index] = nextOffset
      nonWhitespacePrefix[sourceByteOffset + index] = nextNonWhitespaceCount
    }

    if (character === "\n") {
      lineStartByteOffsets.push(sourceByteOffset + characterBytes)
    }

    sourceByteOffset += characterBytes
    offset = nextOffset
    nonWhitespaceCount = nextNonWhitespaceCount
  }

  return { source, bytes, byteToStringOffset, lineStartByteOffsets, nonWhitespacePrefix }
}

export function textForIndexedByteSlice(index: SourceIndex, byteStart: number, byteEnd: number) {
  return decoder.decode(index.bytes.slice(byteStart, byteEnd))
}

export function rangeForIndexedSlice(index: SourceIndex, byteStart: number, byteEnd: number): SourceRange {
  const slice = index.source.slice(
    stringOffsetForByteOffset(index, byteStart),
    stringOffsetForByteOffset(index, byteEnd),
  )
  const lineStart = lineForByteOffset(index, byteStart)
  return {
    byteStart,
    byteEnd,
    lineStart,
    lineEnd: lineStart + lineSpan(slice) - 1,
  }
}

export function nonWhitespaceLengthForIndexedSlice(index: SourceIndex, byteStart: number, byteEnd: number) {
  return index.nonWhitespacePrefix[byteEnd] - index.nonWhitespacePrefix[byteStart]
}

function stringOffsetForByteOffset(index: SourceIndex, byteOffset: number) {
  return index.byteToStringOffset[byteOffset] ?? index.source.length
}

function lineForByteOffset(index: SourceIndex, byteOffset: number) {
  let low = 0
  let high = index.lineStartByteOffsets.length - 1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (index.lineStartByteOffsets[middle] <= byteOffset) {
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return high + 1
}

function lineSpan(slice: string) {
  const measured = slice.endsWith("\n") ? slice.slice(0, -1) : slice
  return measured.split("\n").length
}
