import type { ChunkRecord } from "../shared/types.js"
import {
  createSourceIndex,
  nonWhitespaceLengthForIndexedSlice,
  rangeForIndexedSlice,
  type SourceIndex,
  stableChunkId,
} from "./range.js"

const encoder = new TextEncoder()
const LINE_PATTERN = /.*(?:\n|$)/g
const WHITESPACE_PATTERN = /\s/

export function fallbackChunks(input: {
  filePath: string
  language: string
  text: string
  maxNonWhitespaceChars: number
  sourceIndex?: SourceIndex
  byteOffset?: number
}) {
  const sourceIndex = input.sourceIndex ?? createSourceIndex(input.text)
  const byteOffset = input.byteOffset ?? 0
  const state = fallbackChunkState(byteOffset)

  for (const line of input.text.matchAll(LINE_PATTERN)) {
    appendFallbackLine(state, line[0], input.maxNonWhitespaceChars, {
      filePath: input.filePath,
      language: input.language,
      sourceIndex,
    })
  }

  flushFallbackPending(state, input.filePath, input.language, sourceIndex)

  return state.chunks.map((chunk, index) => ({
    ...chunk,
    previousSiblingChunkId: state.chunks[index - 1]?.id,
    nextSiblingChunkId: state.chunks[index + 1]?.id,
  }))
}

type FallbackChunkState = ReturnType<typeof fallbackChunkState>

function fallbackChunkState(byteOffset: number) {
  return {
    chunks: [] as ChunkRecord[],
    byteStart: byteOffset,
    pending: "",
    pendingStart: byteOffset,
    pendingNonWhitespaceChars: 0,
  }
}

function appendFallbackLine(
  state: FallbackChunkState,
  line: string,
  maxNonWhitespaceChars: number,
  chunkInput: { filePath: string; language: string; sourceIndex: SourceIndex },
) {
  if (!line) {
    return
  }
  for (const part of splitByNonWhitespaceBudget(line, maxNonWhitespaceChars)) {
    appendFallbackPart(state, part, maxNonWhitespaceChars, chunkInput)
  }
}

function appendFallbackPart(
  state: FallbackChunkState,
  part: { text: string; nonWhitespaceChars: number; byteLength: number },
  maxNonWhitespaceChars: number,
  chunkInput: { filePath: string; language: string; sourceIndex: SourceIndex },
) {
  if (state.pending && state.pendingNonWhitespaceChars + part.nonWhitespaceChars > maxNonWhitespaceChars) {
    flushFallbackPending(state, chunkInput.filePath, chunkInput.language, chunkInput.sourceIndex)
  }
  state.pending += part.text
  state.pendingNonWhitespaceChars += part.nonWhitespaceChars
  state.byteStart += part.byteLength
}

function flushFallbackPending(state: FallbackChunkState, filePath: string, language: string, sourceIndex: SourceIndex) {
  if (!state.pending) {
    return
  }
  state.chunks.push(
    makeFallbackChunk(filePath, language, sourceIndex, state.pendingStart, state.byteStart, state.pending),
  )
  state.pending = ""
  state.pendingStart = state.byteStart
  state.pendingNonWhitespaceChars = 0
}

function makeFallbackChunk(
  filePath: string,
  language: string,
  sourceIndex: SourceIndex,
  byteStart: number,
  byteEnd: number,
  text: string,
): ChunkRecord {
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
  }
}

function splitByNonWhitespaceBudget(text: string, maxNonWhitespaceChars: number) {
  const parts: Array<{ text: string; nonWhitespaceChars: number; byteLength: number }> = []
  let pending = ""
  let nonWhitespaceChars = 0
  let byteLength = 0

  for (const character of text) {
    if (pending && !WHITESPACE_PATTERN.test(character) && nonWhitespaceChars >= maxNonWhitespaceChars) {
      parts.push({ text: pending, nonWhitespaceChars, byteLength })
      pending = ""
      nonWhitespaceChars = 0
      byteLength = 0
    }
    pending += character
    byteLength += encoder.encode(character).length
    if (!WHITESPACE_PATTERN.test(character)) {
      nonWhitespaceChars++
    }
  }

  if (pending) {
    parts.push({ text: pending, nonWhitespaceChars, byteLength })
  }

  return parts
}
