import { describe, expect, test } from "bun:test"
import { getChunkById } from "./chunk-lookup.js"
import { createEmptyIndex } from "./store.js"

describe("chunk lookup", () => {
  test("returns chunk with labeled topology and selected related context", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["index diagnostic"],
    })
    index.metadata.status = "ready"
    const source = "class Parser {\n  previous() {}\n  parse() {\n    return value\n  }\n}\n"
    const parentText = source.trimEnd()
    const previousText = "previous() {}"
    const targetText = "parse() {\n    return value\n  }"
    const childText = "return value"
    const previousStart = source.indexOf(previousText)
    const targetStart = source.indexOf(targetText)
    const childStart = source.indexOf(childText)

    index.symbols.classParser = {
      id: "classParser",
      name: "Parser",
      kind: "class",
      filePath: "src/parser.ts",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 6 },
      childSymbolIds: ["methodParse"],
    }
    index.symbols.methodPrevious = {
      id: "methodPrevious",
      name: "previous",
      kind: "method",
      filePath: "src/parser.ts",
      range: { byteStart: previousStart, byteEnd: previousStart + previousText.length, lineStart: 2, lineEnd: 2 },
      parentSymbolId: "classParser",
      childSymbolIds: [],
    }
    index.symbols.methodParse = {
      id: "methodParse",
      name: "parse",
      kind: "method",
      filePath: "src/parser.ts",
      range: { byteStart: targetStart, byteEnd: targetStart + targetText.length, lineStart: 3, lineEnd: 5 },
      parentSymbolId: "classParser",
      childSymbolIds: [],
    }
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 6 },
      text: parentText,
      nonWhitespaceChars: 45,
      nodeTypes: [],
      symbolIds: ["classParser"],
      childChunkIds: ["previous", "target"],
    }
    index.chunks.previous = {
      id: "previous",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: previousStart, byteEnd: previousStart + previousText.length, lineStart: 2, lineEnd: 2 },
      text: previousText,
      nonWhitespaceChars: 12,
      nodeTypes: [],
      symbolIds: ["classParser", "methodPrevious"],
      parentChunkId: "parent",
      childChunkIds: [],
      nextSiblingChunkId: "target",
    }
    index.chunks.target = {
      id: "target",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: targetStart, byteEnd: targetStart + targetText.length, lineStart: 3, lineEnd: 5 },
      text: targetText,
      nonWhitespaceChars: 25,
      nodeTypes: [],
      symbolIds: ["classParser", "methodParse"],
      parentChunkId: "parent",
      childChunkIds: ["child"],
      previousSiblingChunkId: "previous",
    }
    index.chunks.child = {
      id: "child",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: childStart, byteEnd: childStart + childText.length, lineStart: 4, lineEnd: 4 },
      text: childText,
      nonWhitespaceChars: 11,
      nodeTypes: [],
      symbolIds: ["classParser", "methodParse"],
      parentChunkId: "target",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "target", maxContextChars: 12 },
      readSource: async () => source,
    })

    expect(output.diagnostics).toEqual(["index diagnostic"])
    expect(output.chunk).toMatchObject({
      filePath: "src/parser.ts",
      language: "typescript",
      range: { byteStart: targetStart, byteEnd: targetStart + targetText.length, lineStart: 3, lineEnd: 5 },
      kind: "method",
      breadcrumbs: ["class Parser", "method parse"],
      text: targetText,
      parentRange: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 6 },
      topology: {
        chunk: { id: "target", label: "method parse", range: "src/parser.ts:3-5" },
        parent: { id: "parent", label: "class Parser", range: "src/parser.ts:1-6" },
        children: [{ id: "child", label: "block return value", range: "src/parser.ts:4" }],
        previousSibling: { id: "previous", label: "method previous", range: "src/parser.ts:2" },
        symbols: ["class Parser", "method parse"],
      },
      related: {
        parent: { id: "parent", label: "class Parser", range: "src/parser.ts:1-6", text: "class Parser" },
        previousSibling: { id: "previous", label: "method previous", range: "src/parser.ts:2", text: "previous() {" },
        children: [{ id: "child", label: "block return value", range: "src/parser.ts:4", text: "return value" }],
        childrenPage: { offset: 0, limit: 20, total: 1, hasMore: false },
      },
    })
    expect(output.chunk?.parentText).toStartWith("class Parser")
  })

  test("paginates related children and reports child page metadata", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    // biome-ignore lint/security/noSecrets: Test fixture source happens to trip the entropy heuristic.
    const source = "function parent() {\n  child0()\n  child1()\n  child2()\n}\n"
    const parentText = source.trimEnd()
    const child0Text = "child0()"
    const child1Text = "child1()"
    const child2Text = "child2()"
    const child0Start = source.indexOf(child0Text)
    const child1Start = source.indexOf(child1Text)
    const child2Start = source.indexOf(child2Text)

    index.chunks.parent = {
      id: "parent",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 5 },
      text: parentText,
      nonWhitespaceChars: 42,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["child0", "child1", "child2"],
    }
    index.chunks.child0 = {
      id: "child0",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: child0Start, byteEnd: child0Start + child0Text.length, lineStart: 2, lineEnd: 2 },
      text: child0Text,
      nonWhitespaceChars: 8,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }
    index.chunks.child1 = {
      id: "child1",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: child1Start, byteEnd: child1Start + child1Text.length, lineStart: 3, lineEnd: 3 },
      text: child1Text,
      nonWhitespaceChars: 8,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }
    index.chunks.child2 = {
      id: "child2",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: child2Start, byteEnd: child2Start + child2Text.length, lineStart: 4, lineEnd: 4 },
      text: child2Text,
      nonWhitespaceChars: 8,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "parent", childrenOffset: 1, childrenLimit: 1 },
      readSource: async () => source,
    })

    expect(output.chunk?.related.children).toEqual([
      { id: "child1", label: "block child1()", range: "src/parent.ts:3", text: child1Text },
    ])
    expect(output.chunk?.related.childrenPage).toEqual({ offset: 1, limit: 1, total: 3, hasMore: true })
  })

  test("returns only requested child page entries", async () => {
    // Store hydration may still load full topology before this function receives the index;
    // this test protects the response assembly boundary until store-side paging is added.
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    const source = ["function parent() {", ...Array.from({ length: 50 }, (_, child) => `  child${child}()`), "}"].join(
      "\n",
    )
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: source.length, lineStart: 1, lineEnd: 52 },
      text: source,
      nonWhitespaceChars: 400,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: Array.from({ length: 50 }, (_, child) => `child-${child}`),
    }
    for (let child = 0; child < 50; child += 1) {
      const text = `child${child}()`
      const start = source.indexOf(text)
      index.chunks[`child-${child}`] = {
        id: `child-${child}`,
        filePath: "src/parent.ts",
        language: "typescript",
        kind: "block",
        range: { byteStart: start, byteEnd: start + text.length, lineStart: child + 2, lineEnd: child + 2 },
        text,
        nonWhitespaceChars: text.length,
        nodeTypes: [],
        symbolIds: [],
        parentChunkId: "parent",
        childChunkIds: [],
      }
    }

    const output = await getChunkById({
      index,
      input: {
        id: "parent",
        includeChildren: true,
        includeParents: false,
        includeSiblings: false,
        childrenOffset: 10,
        childrenLimit: 5,
        maxContextChars: 100,
      },
      readSource: async () => source,
    })

    expect(output.chunk?.related.children.map((child) => child.id)).toEqual([
      "child-10",
      "child-11",
      "child-12",
      "child-13",
      "child-14",
    ])
    expect(output.chunk?.related.childrenPage).toEqual({ offset: 10, limit: 5, total: 50, hasMore: true })
  })

  test("caps default related child pages and parent context", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    const childCount = 30
    const parentText = "p".repeat(13_000)
    const source = `${parentText}\n${Array.from({ length: childCount }, (_, index) => `child-${index}`).join("\n")}\n`
    index.symbols.parent = {
      id: "parent",
      name: "parent",
      kind: "function",
      filePath: "src/parent.ts",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 1 },
      childSymbolIds: [],
    }
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 1 },
      text: parentText,
      nonWhitespaceChars: parentText.length,
      nodeTypes: [],
      symbolIds: ["parent"],
      childChunkIds: Array.from({ length: childCount }, (_, index) => `child-${index}`),
    }
    let byteStart = parentText.length + 1
    for (let childIndex = 0; childIndex < childCount; childIndex++) {
      const text = `child-${childIndex}`
      index.chunks[`child-${childIndex}`] = {
        id: `child-${childIndex}`,
        filePath: "src/parent.ts",
        language: "typescript",
        kind: "block",
        range: { byteStart, byteEnd: byteStart + text.length, lineStart: childIndex + 2, lineEnd: childIndex + 2 },
        text,
        nonWhitespaceChars: text.length,
        nodeTypes: [],
        symbolIds: [],
        parentChunkId: "parent",
        childChunkIds: [],
      }
      byteStart += text.length + 1
    }

    const output = await getChunkById({
      index,
      input: { id: "parent" },
      readSource: async () => source,
    })

    expect(output.chunk?.text).toHaveLength(12_000)
    expect(output.chunk?.parentText).toHaveLength(12_000)
    expect(output.chunk?.related.children).toHaveLength(20)
    expect(output.chunk?.related.childrenPage).toEqual({ offset: 0, limit: 20, total: childCount, hasMore: true })
  })

  test("returns empty child page metadata when children are disabled", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    const source = "function parent() {\n  child()\n}\n"
    const parentText = source.trimEnd()
    const childText = "child()"
    const childStart = source.indexOf(childText)

    index.chunks.parent = {
      id: "parent",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 3 },
      text: parentText,
      nonWhitespaceChars: 24,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["child"],
    }
    index.chunks.child = {
      id: "child",
      filePath: "src/parent.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: childStart, byteEnd: childStart + childText.length, lineStart: 2, lineEnd: 2 },
      text: childText,
      nonWhitespaceChars: 7,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "parent", includeChildren: false },
      readSource: async () => source,
    })

    expect(output.chunk?.related.children).toEqual([])
    expect(output.chunk?.related.childrenPage).toEqual({ offset: 0, limit: 0, total: 1, hasMore: false })
  })

  test("returns a diagnostic when the chunk id is missing", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["index diagnostic"],
    })
    index.metadata.status = "ready"

    const output = await getChunkById({
      index,
      input: { id: "missing" },
      readSource: async () => "",
    })

    expect(output.chunk).toBeUndefined()
    expect(output.diagnostics).toEqual(["index diagnostic", "chunk not found: missing"])
  })

  test("reports an unavailable index before treating the chunk id as missing", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })

    const output = await getChunkById({
      index,
      input: { id: "missing" },
      readSource: async () => "",
    })

    expect(output.chunk).toBeUndefined()
    expect(output.diagnostics).toEqual(["index unavailable: empty"])
  })

  test("keeps symbol breadcrumbs when parent context is disabled", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.symbols.classParser = {
      id: "classParser",
      name: "Parser",
      kind: "class",
      filePath: "src/parser.ts",
      range: { byteStart: 0, byteEnd: 30, lineStart: 1, lineEnd: 3 },
      childSymbolIds: ["methodParse"],
    }
    index.symbols.methodParse = {
      id: "methodParse",
      name: "parse",
      kind: "method",
      filePath: "src/parser.ts",
      range: { byteStart: 15, byteEnd: 25, lineStart: 2, lineEnd: 2 },
      parentSymbolId: "classParser",
      childSymbolIds: [],
    }
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: { byteStart: 0, byteEnd: 30, lineStart: 1, lineEnd: 3 },
      text: "class Parser {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: ["classParser"],
      childChunkIds: ["target"],
    }
    index.chunks.target = {
      id: "target",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 15, byteEnd: 25, lineStart: 2, lineEnd: 2 },
      text: "parse() {}",
      nonWhitespaceChars: 9,
      nodeTypes: [],
      symbolIds: ["classParser", "methodParse"],
      parentChunkId: "parent",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "target", includeParents: false },
      readSource: async () => "class Parser {\n  parse() {}\n}\n",
    })

    expect(output.chunk?.breadcrumbs).toEqual(["class Parser", "method parse"])
    expect(output.chunk?.parentText).toBeUndefined()
    expect(output.chunk?.related.parent).toBeUndefined()
  })

  test("returns reconstructed chunk text and related chunk text", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    const source = "class Parser {\n  parse() {\n    return value\n  }\n}\n"
    const parentText = source.trimEnd()
    const targetText = "parse() {\n    return value\n  }"
    const childText = "return value"
    const targetStart = source.indexOf(targetText)
    const childStart = source.indexOf(childText)
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 5 },
      text: parentText,
      nonWhitespaceChars: 36,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["target"],
    }
    index.chunks.target = {
      id: "target",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: targetStart, byteEnd: targetStart + targetText.length, lineStart: 2, lineEnd: 4 },
      text: targetText,
      nonWhitespaceChars: 25,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: ["child"],
    }
    index.chunks.child = {
      id: "child",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: childStart, byteEnd: childStart + childText.length, lineStart: 3, lineEnd: 3 },
      text: childText,
      nonWhitespaceChars: 11,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "target",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "target", maxContextChars: 20 },
      readSource: async () => source,
    })

    expect(output.chunk?.text).toBe(targetText)
    expect(output.chunk?.related.parent?.text).toBe(parentText.slice(0, 20))
    expect(output.chunk?.related.children).toEqual([
      { id: "child", label: "block return value", range: "src/parser.ts:3", text: childText },
    ])
    expect(output.diagnostics).toEqual([])
  })

  test("does not return stale hydrated target or related chunk text when source read fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["source read failed for src/parser.ts; chunk text unavailable"],
    })
    index.metadata.status = "ready"
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 3 },
      text: "class Parser {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["target"],
    }
    index.chunks.target = {
      id: "target",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "parse() {}",
      nonWhitespaceChars: 9,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "target" },
      readSource: async () => {
        throw new Error("read failed")
      },
    })

    expect(output.chunk?.text).toBe("")
    expect(output.chunk?.related.parent?.text).toBe("")
    expect(output.chunk?.parentText).toBeUndefined()
    expect(output.diagnostics).toContain("source read failed for src/parser.ts; chunk text unavailable")
    expect(output.diagnostics).toContain("source read failed for src/parser.ts; parent context omitted")
    expect(output.diagnostics).toContain("source read failed for src/parser.ts:parent; related chunk text omitted")
  })

  test("does not return stale hydrated target or related chunk text when source mismatches indexed ranges", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 3 },
      text: "class Parser {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["target"],
    }
    index.chunks.target = {
      id: "target",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 15, byteEnd: 25, lineStart: 2, lineEnd: 2 },
      text: "parse() {}",
      nonWhitespaceChars: 9,
      nodeTypes: [],
      symbolIds: [],
      parentChunkId: "parent",
      childChunkIds: [],
    }

    const output = await getChunkById({
      index,
      input: { id: "target" },
      readSource: async () => "class Parser {\n  stale() {}\n}\n",
    })

    expect(output.chunk?.text).toBe("")
    expect(output.chunk?.related.parent?.text).toBe("")
    expect(output.chunk?.parentText).toBeUndefined()
    expect(output.diagnostics).toContain("source mismatch for src/parser.ts:target; chunk text omitted")
    expect(output.diagnostics).toContain("source mismatch for src/parser.ts:target; parent context omitted")
    expect(output.diagnostics).toContain("source mismatch for src/parser.ts:parent; related chunk text omitted")
  })
})
