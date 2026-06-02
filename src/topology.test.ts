import { describe, expect, test } from "bun:test"
import type { SyntaxNode } from "./cast.js"
import {
  assignSymbolsToChunks,
  attachTopology,
  expandWithParentContext,
  extractSymbols,
  summarizeTopology,
} from "./topology.js"
import { linkChunkTopology, linkSymbolsToChunks } from "./topology-relations.js"
import type { ChunkRecord, SymbolRecord } from "./types.js"

const base = {
  filePath: "src/a.ts",
  language: "typescript",
  nodeTypes: [],
  symbolIds: [],
  childChunkIds: [],
  nonWhitespaceChars: 1,
} satisfies Partial<ChunkRecord>

function chunk(id: string, filePath: string, byteStart: number, byteEnd: number): ChunkRecord {
  return {
    ...base,
    id,
    filePath,
    kind: "block",
    range: { byteStart, byteEnd, lineStart: 1, lineEnd: 1 },
    text: id,
  } as ChunkRecord
}

describe("topology", () => {
  test("links relation helpers directly", () => {
    const symbol: SymbolRecord = {
      id: "sym:function:inner",
      name: "inner",
      kind: "function",
      filePath: "src/a.ts",
      range: { byteStart: 10, byteEnd: 20, lineStart: 2, lineEnd: 2 },
      childSymbolIds: [],
    }
    const root = chunk("root", "src/a.ts", 0, 40)
    const child = chunk("child", "src/a.ts", 10, 20)

    const withSymbols = linkSymbolsToChunks([root, child], { [symbol.id]: symbol })
    const withTopology = linkChunkTopology(withSymbols, { [symbol.id]: symbol })

    expect(withTopology.find((candidate) => candidate.id === "child")?.symbolIds).toEqual([symbol.id])
    expect(withTopology.find((candidate) => candidate.id === "child")?.parentChunkId).toBe("root")
    expect(withTopology.find((candidate) => candidate.id === "root")?.childChunkIds).toEqual(["child"])
  })

  test("links many deeply nested symbols and chunks without changing ordering", () => {
    const symbolCount = 10_000
    const starts: number[] = []
    const ends: number[] = []
    let source = ""
    for (let index = 0; index < symbolCount; index += 1) {
      starts.push(source.length)
      source += `function s${index}() {\n`
    }
    for (let index = symbolCount - 1; index >= 0; index -= 1) {
      source += "}\n"
      ends[index] = source.length - 1
    }

    let child: SyntaxNode | undefined
    for (let index = symbolCount - 1; index >= 0; index -= 1) {
      child = {
        type: "function_declaration",
        startIndex: starts[index],
        endIndex: ends[index],
        children: child ? [child] : [],
      }
    }

    const symbols = extractSymbols({ filePath: "src/deep.ts", source, nodes: child ? [child] : [] })
    const symbolsById = Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol]))
    const symbolId = (index: number) => `src/deep.ts:function:s${index}:${starts[index]}:${ends[index]}`
    const chunkDepths = Array.from({ length: 25 }, (_, index) => index * 200)
    const chunks = chunkDepths.map((depth) =>
      chunk(`chunk:${depth}`, "src/deep.ts", starts[depth], starts[depth] + `function s${depth}() {`.length),
    )

    const linked = assignSymbolsToChunks(chunks, symbolsById)
    const deepest = linked.at(-1)

    expect(symbols).toHaveLength(symbolCount)
    expect(symbols[0].childSymbolIds).toEqual([symbolId(1)])
    expect(symbols[4999].childSymbolIds).toEqual([symbolId(5000)])
    expect(deepest?.symbolIds).toHaveLength(4801)
    expect(deepest?.symbolIds.slice(0, 3)).toEqual([symbolId(0), symbolId(1), symbolId(2)])
    expect(deepest?.symbolIds.slice(-3)).toEqual([symbolId(4798), symbolId(4799), symbolId(4800)])
  })

  test("traverses deeply nested non-symbol nodes without overflowing the JS stack", () => {
    let child: SyntaxNode | undefined
    for (let index = 0; index < 50_000; index += 1) {
      child = { type: "statement_block", startIndex: 0, endIndex: 0, children: child ? [child] : [] }
    }

    expect(extractSymbols({ filePath: "src/deep.ts", source: "", nodes: child ? [child] : [] })).toEqual([])
  })

  test("attaches topology for hundreds of nested chunks without recursive traversal", () => {
    const chunkCount = 1000
    const chunks = Array.from({ length: chunkCount }, (_, index) =>
      chunk(`chunk:${index}`, "src/deep.ts", index, chunkCount * 2 - index),
    )

    const linked = attachTopology(chunks, {})

    expect(linked).toHaveLength(chunkCount)
    expect(linked[0].parentChunkId).toBeUndefined()
    expect(linked[0].childChunkIds).toEqual(["chunk:1"])
    expect(linked[500].parentChunkId).toBe("chunk:499")
    expect(linked[500].childChunkIds).toEqual(["chunk:501"])
    expect(linked.at(-1)?.parentChunkId).toBe("chunk:998")
    expect(linked.at(-1)?.childChunkIds).toEqual([])
  })

  test("links children to parent symbols and siblings", () => {
    const parent: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
      childSymbolIds: [],
    }
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:1",
          kind: "method",
          range: { byteStart: 10, byteEnd: 20, lineStart: 2, lineEnd: 2 },
          text: "a() {}",
          symbolIds: [parent.id],
        },
        {
          ...base,
          id: "chunk:2",
          kind: "method",
          range: { byteStart: 21, byteEnd: 31, lineStart: 3, lineEnd: 3 },
          text: "b() {}",
          symbolIds: [parent.id],
        },
      ] as ChunkRecord[],
      { [parent.id]: parent },
    )

    expect(chunks[0].previousSiblingChunkId).toBeUndefined()
    expect(chunks[0].nextSiblingChunkId).toBe("chunk:2")
    expect(chunks[1].previousSiblingChunkId).toBe("chunk:1")
  })

  test("does not link unrelated chunks from different nearest symbols as siblings", () => {
    const parentA: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 3 },
      childSymbolIds: [],
    }
    const parentB: SymbolRecord = {
      id: "sym:class:B",
      name: "B",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 21, byteEnd: 42, lineStart: 4, lineEnd: 6 },
      childSymbolIds: [],
    }
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:a",
          kind: "method",
          range: { byteStart: 10, byteEnd: 18, lineStart: 2, lineEnd: 2 },
          text: "a() {}",
          symbolIds: [parentA.id],
        },
        {
          ...base,
          id: "chunk:b",
          kind: "method",
          range: { byteStart: 31, byteEnd: 39, lineStart: 5, lineEnd: 5 },
          text: "b() {}",
          symbolIds: [parentB.id],
        },
      ] as ChunkRecord[],
      { [parentA.id]: parentA, [parentB.id]: parentB },
    )

    expect(chunks[0].nextSiblingChunkId).toBeUndefined()
    expect(chunks[1].previousSiblingChunkId).toBeUndefined()
  })

  test("does not link chunks from different methods in the same class as siblings", () => {
    const parent: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 60, lineStart: 1, lineEnd: 5 },
      childSymbolIds: ["sym:method:a", "sym:method:b"],
    }
    const methodA: SymbolRecord = {
      id: "sym:method:a",
      name: "a",
      kind: "method",
      filePath: "src/a.ts",
      range: { byteStart: 10, byteEnd: 25, lineStart: 2, lineEnd: 2 },
      parentSymbolId: parent.id,
      childSymbolIds: [],
    }
    const methodB: SymbolRecord = {
      id: "sym:method:b",
      name: "b",
      kind: "method",
      filePath: "src/a.ts",
      range: { byteStart: 30, byteEnd: 45, lineStart: 3, lineEnd: 3 },
      parentSymbolId: parent.id,
      childSymbolIds: [],
    }
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:a",
          kind: "method",
          range: { byteStart: 12, byteEnd: 20, lineStart: 2, lineEnd: 2 },
          text: "a() {}",
          symbolIds: [parent.id, methodA.id],
        },
        {
          ...base,
          id: "chunk:b",
          kind: "method",
          range: { byteStart: 32, byteEnd: 40, lineStart: 3, lineEnd: 3 },
          text: "b() {}",
          symbolIds: [parent.id, methodB.id],
        },
      ] as ChunkRecord[],
      { [parent.id]: parent, [methodA.id]: methodA, [methodB.id]: methodB },
    )

    expect(chunks[0].nextSiblingChunkId).toBeUndefined()
    expect(chunks[1].previousSiblingChunkId).toBeUndefined()
  })

  test("links immediate topology for nested chunks across multiple files", () => {
    const chunks = attachTopology(
      [
        chunk("a:file", "src/a.ts", 0, 100),
        chunk("a:class", "src/a.ts", 10, 90),
        chunk("a:method", "src/a.ts", 20, 70),
        chunk("a:block:1", "src/a.ts", 30, 40),
        chunk("a:block:2", "src/a.ts", 50, 60),
        chunk("b:file", "src/b.ts", 0, 100),
        chunk("b:block", "src/b.ts", 10, 20),
      ],
      {},
    )
    const byId = Object.fromEntries(chunks.map((item) => [item.id, item]))

    expect(byId["a:file"].childChunkIds).toEqual(["a:class"])
    expect(byId["a:class"].parentChunkId).toBe("a:file")
    expect(byId["a:class"].childChunkIds).toEqual(["a:method"])
    expect(byId["a:method"].parentChunkId).toBe("a:class")
    expect(byId["a:method"].childChunkIds).toEqual(["a:block:1", "a:block:2"])
    expect(byId["a:block:1"].nextSiblingChunkId).toBe("a:block:2")
    expect(byId["a:block:2"].previousSiblingChunkId).toBe("a:block:1")
    expect(byId["b:file"].childChunkIds).toEqual(["b:block"])
    expect(byId["b:block"].parentChunkId).toBe("b:file")
  })

  test("links symbol-less siblings only within the same direct parent", () => {
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "parent:a",
          kind: "block",
          range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
          text: "parent a",
          symbolIds: [],
        },
        {
          ...base,
          id: "child:a1",
          kind: "block",
          range: { byteStart: 5, byteEnd: 10, lineStart: 2, lineEnd: 2 },
          text: "child a1",
          symbolIds: [],
        },
        {
          ...base,
          id: "child:a2",
          kind: "block",
          range: { byteStart: 12, byteEnd: 18, lineStart: 3, lineEnd: 3 },
          text: "child a2",
          symbolIds: [],
        },
        {
          ...base,
          id: "parent:b",
          kind: "block",
          range: { byteStart: 41, byteEnd: 60, lineStart: 5, lineEnd: 6 },
          text: "parent b",
          symbolIds: [],
        },
      ] as ChunkRecord[],
      {},
    )
    const byId = Object.fromEntries(chunks.map((chunk) => [chunk.id, chunk]))

    expect(byId["parent:a"].previousSiblingChunkId).toBeUndefined()
    expect(byId["parent:a"].nextSiblingChunkId).toBe("parent:b")
    expect(byId["child:a1"].previousSiblingChunkId).toBeUndefined()
    expect(byId["child:a1"].nextSiblingChunkId).toBe("child:a2")
    expect(byId["child:a2"].previousSiblingChunkId).toBe("child:a1")
    expect(byId["child:a2"].nextSiblingChunkId).toBeUndefined()
    expect(byId["parent:b"].previousSiblingChunkId).toBe("parent:a")
  })

  test("does not link parent or child chunks across files", () => {
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:a",
          kind: "block",
          range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
          text: "a",
          symbolIds: [],
        },
        {
          ...base,
          id: "chunk:b",
          filePath: "src/b.ts",
          kind: "block",
          range: { byteStart: 10, byteEnd: 20, lineStart: 2, lineEnd: 2 },
          text: "b",
          symbolIds: [],
        },
      ] as ChunkRecord[],
      {},
    )

    expect(chunks[0].parentChunkId).toBeUndefined()
    expect(chunks[0].childChunkIds).toEqual([])
    expect(chunks[1].parentChunkId).toBeUndefined()
    expect(chunks[1].childChunkIds).toEqual([])
  })

  test("does not link chunks with the same range as parent or child", () => {
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:a",
          kind: "block",
          range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
          text: "same range a",
          symbolIds: [],
        },
        {
          ...base,
          id: "chunk:b",
          kind: "block",
          range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
          text: "same range b",
          symbolIds: [],
        },
      ] as ChunkRecord[],
      {},
    )

    expect(chunks[0].parentChunkId).toBeUndefined()
    expect(chunks[0].childChunkIds).toEqual([])
    expect(chunks[1].parentChunkId).toBeUndefined()
    expect(chunks[1].childChunkIds).toEqual([])
  })

  test("links chunks with strictly containing ranges as parent and child", () => {
    const chunks = attachTopology(
      [
        {
          ...base,
          id: "chunk:parent",
          kind: "block",
          range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
          text: "parent",
          symbolIds: [],
        },
        {
          ...base,
          id: "chunk:child",
          kind: "block",
          range: { byteStart: 10, byteEnd: 30, lineStart: 2, lineEnd: 3 },
          text: "child",
          symbolIds: [],
        },
      ] as ChunkRecord[],
      {},
    )

    expect(chunks[0].parentChunkId).toBeUndefined()
    expect(chunks[0].childChunkIds).toEqual(["chunk:child"])
    expect(chunks[1].parentChunkId).toBe("chunk:parent")
    expect(chunks[1].childChunkIds).toEqual([])
  })

  test("summarizes topology with labels and one-based ranges", () => {
    const classSymbol: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 80, lineStart: 1, lineEnd: 5 },
      childSymbolIds: ["sym:method:run"],
    }
    const methodSymbol: SymbolRecord = {
      id: "sym:method:run",
      name: "run",
      kind: "method",
      filePath: "src/a.ts",
      range: { byteStart: 20, byteEnd: 40, lineStart: 3, lineEnd: 3 },
      parentSymbolId: classSymbol.id,
      childSymbolIds: [],
    }
    const functionSymbol: SymbolRecord = {
      id: "sym:function:before",
      name: "before",
      kind: "function",
      filePath: "src/a.ts",
      range: { byteStart: 10, byteEnd: 18, lineStart: 2, lineEnd: 2 },
      childSymbolIds: [],
    }
    const chunk = {
      ...base,
      id: "chunk:method",
      kind: "method",
      range: { byteStart: 20, byteEnd: 40, lineStart: 3, lineEnd: 3 },
      text: "run() {}",
      symbolIds: [classSymbol.id, methodSymbol.id],
      parentChunkId: "chunk:class",
      childChunkIds: ["chunk:block"],
      previousSiblingChunkId: "chunk:function",
      nextSiblingChunkId: "chunk:file",
    } as ChunkRecord
    const chunks: Record<string, ChunkRecord> = {
      [chunk.id]: chunk,
      "chunk:class": {
        ...base,
        id: "chunk:class",
        kind: "class",
        range: { byteStart: 0, byteEnd: 80, lineStart: 1, lineEnd: 5 },
        text: "class A {}",
        symbolIds: [classSymbol.id],
      } as ChunkRecord,
      "chunk:block": {
        ...base,
        id: "chunk:block",
        kind: "block",
        range: { byteStart: 30, byteEnd: 36, lineStart: 4, lineEnd: 4 },
        text: "body",
        symbolIds: [],
      } as ChunkRecord,
      "chunk:function": {
        ...base,
        id: "chunk:function",
        kind: "function",
        range: { byteStart: 10, byteEnd: 18, lineStart: 2, lineEnd: 2 },
        text: "before()",
        symbolIds: [functionSymbol.id],
      } as ChunkRecord,
      "chunk:file": {
        ...base,
        id: "chunk:file",
        kind: "file",
        range: { byteStart: 0, byteEnd: 120, lineStart: 1, lineEnd: 8 },
        text: "file",
        symbolIds: [],
      } as ChunkRecord,
    }

    expect(
      summarizeTopology(chunk, chunks, {
        [classSymbol.id]: classSymbol,
        [methodSymbol.id]: methodSymbol,
        [functionSymbol.id]: functionSymbol,
      }),
    ).toEqual({
      chunk: { id: "chunk:method", label: "method run", range: "src/a.ts:3" },
      parent: { id: "chunk:class", label: "class A", range: "src/a.ts:1-5" },
      children: [{ id: "chunk:block", label: "block body", range: "src/a.ts:4" }],
      previousSibling: { id: "chunk:function", label: "function before", range: "src/a.ts:2" },
      nextSibling: { id: "chunk:file", label: "file src/a.ts", range: "src/a.ts:1-8" },
      symbols: ["class A", "method run"],
    })
  })

  test("caps summarized topology children", () => {
    const childCount = 30
    const chunk = {
      ...base,
      id: "chunk:parent",
      kind: "function",
      range: { byteStart: 0, byteEnd: 1000, lineStart: 1, lineEnd: 50 },
      text: "parent",
      childChunkIds: Array.from({ length: childCount }, (_, index) => `chunk:child:${index}`),
    } as ChunkRecord
    const chunks = {
      [chunk.id]: chunk,
      ...Object.fromEntries(
        Array.from({ length: childCount }, (_, index) => [
          `chunk:child:${index}`,
          {
            ...base,
            id: `chunk:child:${index}`,
            kind: "block",
            range: { byteStart: index, byteEnd: index + 1, lineStart: index + 1, lineEnd: index + 1 },
            text: `child ${index}`,
          } as ChunkRecord,
        ]),
      ),
    }

    const topology = summarizeTopology(chunk, chunks, {})

    expect(topology.children).toHaveLength(20)
    expect(topology.children.at(0)?.id).toBe("chunk:child:0")
    expect(topology.children.at(-1)?.id).toBe("chunk:child:19")
  })

  test("uses local chunk snippets before broad enclosing symbols", () => {
    const broadSymbol: SymbolRecord = {
      id: "sym:function:store",
      name: "store",
      kind: "function",
      filePath: "src/plugin.ts",
      range: { byteStart: 0, byteEnd: 200, lineStart: 1, lineEnd: 10 },
      childSymbolIds: [],
    }
    const chunk = {
      ...base,
      id: "chunk:tool",
      kind: "block",
      range: { byteStart: 80, byteEnd: 140, lineStart: 5, lineEnd: 8 },
      text: "semantic_search_code: tool({\n  async execute() {}\n})",
      symbolIds: [broadSymbol.id],
    } as ChunkRecord

    expect(summarizeTopology(chunk, { [chunk.id]: chunk }, { [broadSymbol.id]: broadSymbol }).chunk.label).toBe(
      "block semantic_search_code: tool({",
    )
  })

  test("skips leading separators when building local snippet labels", () => {
    const chunk = {
      ...base,
      id: "chunk:tool",
      kind: "method",
      range: { byteStart: 80, byteEnd: 140, lineStart: 5, lineEnd: 8 },
      text: ",\n  semantic_get_chunk: tool({\n    async execute() {}\n  })",
      symbolIds: [],
    } as ChunkRecord

    expect(summarizeTopology(chunk, { [chunk.id]: chunk }, {}).chunk.label).toBe("method semantic_get_chunk: tool({")
  })

  test("uses local fallback labels for symbol-less chunks", () => {
    const chunk = {
      ...base,
      id: "chunk:return",
      kind: "block",
      range: { byteStart: 20, byteEnd: 38, lineStart: 2, lineEnd: 2 },
      text: "return parseOptions(input)",
      symbolIds: [],
    } as ChunkRecord

    expect(summarizeTopology(chunk, { [chunk.id]: chunk }, {}).chunk.label).toBe("block return parseOptions(input)")
  })

  test("does not duplicate chunk kind in local fallback labels", () => {
    const chunk = {
      ...base,
      id: "chunk:function",
      kind: "function",
      range: { byteStart: 20, byteEnd: 50, lineStart: 2, lineEnd: 4 },
      text: "function parseOptions() {\n  return {}\n}",
      symbolIds: [],
    } as ChunkRecord

    expect(summarizeTopology(chunk, { [chunk.id]: chunk }, {}).chunk.label).toBe("function parseOptions() {")
  })

  test("extracts enclosing class and assigns it to contained chunks", () => {
    const source = "class A {\n  a() {}\n}\n"
    const symbols = extractSymbols({
      filePath: "src/a.ts",
      source,
      nodes: [
        {
          type: "class_declaration",
          startIndex: 0,
          endIndex: 20,
          children: [{ type: "method_definition", startIndex: 12, endIndex: 18, children: [] }],
        },
      ],
    })
    const [chunk] = assignSymbolsToChunks(
      [
        {
          ...base,
          id: "chunk:method",
          kind: "method",
          range: { byteStart: 12, byteEnd: 18, lineStart: 2, lineEnd: 2 },
          text: "a() {}",
          symbolIds: [],
        } as ChunkRecord,
      ],
      Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
    )

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(["class:A", "method:a"])
    expect(symbols[0].childSymbolIds).toEqual(["src/a.ts:method:a:12:18"])
    expect(symbols[1].parentSymbolId).toBe("src/a.ts:class:A:0:20")
    expect(chunk.symbolIds).toEqual(["src/a.ts:class:A:0:20", "src/a.ts:method:a:12:18"])
  })

  test("extracts object property call names as local function symbols", () => {
    const source = `const tools = {
  semantic_search_code: tool({
    async execute() {
      return "ok"
    },
  }),
}
`
    const propertyStart = source.indexOf("semantic_search_code")
    const propertyEnd = source.indexOf("  }),") + "  })".length
    const symbols = extractSymbols({
      filePath: "src/plugin.ts",
      source,
      nodes: [{ type: "pair", startIndex: propertyStart, endIndex: propertyEnd, children: [] }],
    })

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(["function:semantic_search_code"])
  })

  test("extracts test descriptions as local function symbols", () => {
    const source = `test("filters nonsense results", async () => {
  expect(true).toBe(true)
})
`
    const symbols = extractSymbols({
      filePath: "src/retriever.test.ts",
      source,
      nodes: [{ type: "call_expression", startIndex: 0, endIndex: source.trimEnd().length, children: [] }],
    })

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(["function:test filters nonsense results"])
  })

  test("extracts test descriptions containing other quotes", () => {
    const source = String.raw`test("doesn't overmatch", async () => {
  expect(true).toBe(true)
})

test('handles "quoted" words', () => {
  expect(true).toBe(true)
})

test("handles \"escaped\" words", () => {
  expect(true).toBe(true)
})
`
    const secondTestStart = source.indexOf("test('handles")
    const thirdTestStart = source.indexOf('test("handles')
    const symbols = extractSymbols({
      filePath: "src/retriever.test.ts",
      source,
      nodes: [
        { type: "call_expression", startIndex: 0, endIndex: source.indexOf("\n\ntest"), children: [] },
        {
          type: "call_expression",
          startIndex: secondTestStart,
          endIndex: source.indexOf("\n\ntest", secondTestStart),
          children: [],
        },
        {
          type: "call_expression",
          startIndex: thirdTestStart,
          endIndex: source.trimEnd().length,
          children: [],
        },
      ],
    })

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
      "function:test doesn't overmatch",
      'function:test handles "quoted" words',
      'function:test handles "escaped" words',
    ])
  })

  test("does not extract type property signatures as function symbols", () => {
    const source = "interface Options {\n  onDone: () => void\n}\n"
    const propertyStart = source.indexOf("onDone")
    const propertyEnd = source.indexOf("\n}")
    const symbols = extractSymbols({
      filePath: "src/options.ts",
      source,
      nodes: [
        {
          type: "interface_declaration",
          startIndex: 0,
          endIndex: source.trimEnd().length,
          children: [{ type: "property_signature", startIndex: propertyStart, endIndex: propertyEnd, children: [] }],
        },
      ],
    })

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(["interface:Options"])
  })

  test("does not assign symbols from another file with overlapping byte ranges", () => {
    const symbol: SymbolRecord = {
      id: "src/a.ts:class:A:0:40",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 40, lineStart: 1, lineEnd: 4 },
      childSymbolIds: [],
    }
    const [chunk] = assignSymbolsToChunks(
      [
        {
          ...base,
          id: "chunk:b",
          filePath: "src/b.ts",
          kind: "method",
          range: { byteStart: 10, byteEnd: 20, lineStart: 2, lineEnd: 2 },
          text: "b() {}",
          symbolIds: [],
        } as ChunkRecord,
      ],
      { [symbol.id]: symbol },
    )

    expect(chunk.symbolIds).toEqual([])
  })

  test("uses UTF-8 byte ranges when extracting names and parent text", () => {
    const source = "const café = true\nclass Éclair {\n  goût() {}\n}\n"
    const classStart = new TextEncoder().encode("const café = true\n").length
    const methodStart = new TextEncoder().encode("const café = true\nclass Éclair {\n  ").length
    const methodEnd = new TextEncoder().encode("const café = true\nclass Éclair {\n  goût() {}").length
    const classEnd = new TextEncoder().encode(source.trimEnd()).length
    const symbols = extractSymbols({
      filePath: "src/a.ts",
      source,
      nodes: [
        {
          type: "class_declaration",
          startIndex: classStart,
          endIndex: classEnd,
          children: [{ type: "method_definition", startIndex: methodStart, endIndex: methodEnd, children: [] }],
        },
      ],
    })
    const result = expandWithParentContext({
      chunk: {
        ...base,
        id: "chunk:method",
        kind: "method",
        range: { byteStart: methodStart, byteEnd: methodEnd, lineStart: 3, lineEnd: 3 },
        text: "goût() {}",
        symbolIds: symbols.map((symbol) => symbol.id),
      } as ChunkRecord,
      symbols: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
      source,
      maxContextChars: 100,
    })

    expect(symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual(["class:Éclair", "method:goût"])
    expect(result.parentText).toBe("class Éclair {\n  goût() {}\n}")
    expect(result.breadcrumbs).toEqual(["class Éclair", "method goût"])
  })

  test("adds parent context when it fits budget", () => {
    const chunk = {
      ...base,
      id: "chunk:method",
      kind: "method",
      range: { byteStart: 12, byteEnd: 20, lineStart: 2, lineEnd: 2 },
      text: "a() {}",
      symbolIds: ["sym:class:A"],
    } as ChunkRecord
    const parent: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 28, lineStart: 1, lineEnd: 3 },
      childSymbolIds: [],
    }
    const result = expandWithParentContext({
      chunk,
      symbols: { [parent.id]: parent },
      source: "class A {\n  a() {}\n}\n",
      maxContextChars: 100,
    })

    expect(result.parentText).toBe("class A {\n  a() {}\n}")
    expect(result.parentRange).toEqual(parent.range)
    expect(result.breadcrumbs).toEqual(["class A"])
  })

  test("returns breadcrumb and excerpt when parent exceeds budget", () => {
    const chunk = {
      ...base,
      id: "chunk:method",
      kind: "method",
      range: { byteStart: 30, byteEnd: 38, lineStart: 3, lineEnd: 3 },
      text: "a() {}",
      symbolIds: ["sym:class:A"],
    } as ChunkRecord
    const parent: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 46, lineStart: 1, lineEnd: 4 },
      childSymbolIds: [],
    }
    const result = expandWithParentContext({
      chunk,
      symbols: { [parent.id]: parent },
      source: "class A {\n  longField = true\n  a() {}\n}\n",
      maxContextChars: 20,
    })

    expect(result.parentText).toContain("class A")
    expect(requiredParentText(result).length).toBeLessThanOrEqual(20)
    expect(result.parentRange).toEqual(parent.range)
    expect(result.breadcrumbs).toEqual(["class A"])
  })

  test("returns excerpt when whitespace-heavy parent text exceeds budget", () => {
    const source = "class A {\n\n\n\n\n  a() {}\n}\n"
    const chunk = {
      ...base,
      id: "chunk:method",
      kind: "method",
      range: { byteStart: 17, byteEnd: 25, lineStart: 6, lineEnd: 6 },
      text: "a() {}",
      symbolIds: ["sym:class:A"],
    } as ChunkRecord
    const parent: SymbolRecord = {
      id: "sym:class:A",
      name: "A",
      kind: "class",
      filePath: "src/a.ts",
      range: { byteStart: 0, byteEnd: 28, lineStart: 1, lineEnd: 7 },
      childSymbolIds: [],
    }
    const result = expandWithParentContext({ chunk, symbols: { [parent.id]: parent }, source, maxContextChars: 20 })

    expect(result.parentText).not.toBe(source.trimEnd())
    expect(result.parentText).toContain("class A")
    expect(requiredParentText(result).length).toBeLessThanOrEqual(20)
  })
})

function requiredParentText(result: { parentText?: string }) {
  if (result.parentText === undefined) {
    throw new Error("expected parent text")
  }
  return result.parentText
}
