import { describe, expect, test } from "vitest"
import {
  createSourceIndex,
  nonWhitespaceLengthForIndexedSlice,
  rangeForIndexedSlice,
  rangeForSlice,
  textForByteSlice,
  textForIndexedByteSlice,
} from "./range.js"

const encoder = new TextEncoder()

function byteLength(text: string) {
  return encoder.encode(text).length
}

describe("range helpers", () => {
  test("slices indexed UTF-8 byte ranges containing multibyte characters", () => {
    const source = "aé😀z"
    const index = createSourceIndex(source)

    expect(textForIndexedByteSlice(index, byteLength("a"), byteLength("aé😀"))).toBe("é😀")
  })

  test("computes indexed byte and line ranges", () => {
    const source = "one\né\nthree\n"
    const index = createSourceIndex(source)

    expect(rangeForIndexedSlice(index, byteLength("one\n"), byteLength("one\né\nthree"))).toEqual({
      byteStart: 4,
      byteEnd: 12,
      lineStart: 2,
      lineEnd: 3,
    })
  })

  test("counts indexed non-whitespace text", () => {
    const source = "a \té\n😀 b"
    const index = createSourceIndex(source)

    expect(nonWhitespaceLengthForIndexedSlice(index, byteLength("a "), byteLength("a \té\n😀 "))).toBe(2)
  })

  test("textForByteSlice preserves existing byte slice behavior", () => {
    const source = "aé😀z"

    expect(textForByteSlice(source, byteLength("a"), byteLength("aé😀"))).toBe("é😀")
  })

  test("rangeForSlice preserves existing line span behavior", () => {
    expect(rangeForSlice("one\ntwo\nthree\n", 4, 8)).toEqual({ byteStart: 4, byteEnd: 8, lineStart: 2, lineEnd: 2 })
    expect(rangeForSlice("a\nb\n", 0, 4)).toEqual({ byteStart: 0, byteEnd: 4, lineStart: 1, lineEnd: 2 })
  })
})
