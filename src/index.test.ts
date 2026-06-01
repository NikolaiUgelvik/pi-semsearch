import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HYDE_SYSTEM_PROMPT } from "./hyde.js"
import castPlugin from "./index.js"
import { createCastPluginForTest } from "./plugin.js"
import { createEmptyIndex } from "./store.js"

const input = {
  project: { id: "p", worktree: "/repo", time: { created: 0 } },
  directory: "/repo",
  worktree: "/repo",
}

describe("cast plugin", () => {
  test("root module exposes only the default plugin", async () => {
    const entrypoint = await import("./index.js")

    expect(Object.keys(entrypoint)).toEqual(["default"])
    expect(entrypoint.default).toBeFunction()
  })

  test("registers semantic_search_code and semantic_get_chunk", async () => {
    const hooks = await castPlugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    expect(Object.keys(hooks.tool ?? {})).toEqual(["semantic_search_code", "semantic_get_chunk"])
    await hooks.dispose?.()
  })

  test("semantic_search_code description explains semantic search usage", async () => {
    const hooks = await castPlugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const description = semanticSearchTool(hooks).description
    expect(description).toContain("by meaning instead of exact text")
    expect(description).toContain("behavior, features, APIs, errors, data flow")
    expect(description).toContain("compact ranked matches")
    expect(description).toContain("semantic_get_chunk")
    expect(description).toContain("Use paths to restrict the search area")
    expect(description).toContain("Use refresh if files may have changed")
    await hooks.dispose?.()
  })

  test("semantic_get_chunk description explains context expansion and child paging", async () => {
    const hooks = await castPlugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const description = semanticGetChunkTool(hooks).description
    expect(description).toContain("parent context")
    expect(description).toContain("childrenOffset")
    expect(description).toContain("childrenLimit")
    await hooks.dispose?.()
  })

  test("semantic_search_code compacts output to configured opencode tool_output limits", async () => {
    const diagnostic = "output compacted to fit opencode tool_output limits; use semantic_get_chunk for more context"
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [
          {
            filePath: "source.ts",
            language: "typescript",
            range: { byteStart: 0, byteEnd: 5000, lineStart: 1, lineEnd: 200 },
            score: 0.9,
            finalScore: 0.95,
            kind: "function",
            breadcrumbs: ["function large"],
            text: "x".repeat(2000),
            parentText: "parent".repeat(500),
            parentRange: { byteStart: 0, byteEnd: 6000, lineStart: 1, lineEnd: 240 },
            topology: {
              chunk: { id: "c1", label: "function large", range: "source.ts:1-200" },
              children: [],
              symbols: ["function large"],
            },
            retrieval: { mode: "hybrid", vectorRank: 1, bm25Rank: 1, rerankRank: 1, rerankScore: 0.95 },
          },
        ],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })
    hooks.config?.({ tool_output: { max_lines: 80, max_bytes: 900 } } as never)

    const result = await semanticSearchTool(hooks).execute({ query: "a", includeParents: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(900)
    const output = JSON.parse(result.output)
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.results[0].parentRange).toBeUndefined()
    if (output.diagnostics) {
      expect(output.diagnostics).toContain(diagnostic)
    }
  })

  test("semantic_search_code summarizes diagnostics when results are present", async () => {
    const diagnostics = [
      ...Array.from({ length: 80 }, (_, index) => `binary asset omitted ${index}: ${"x".repeat(80)}`),
      "HyDE failed: upstream timeout",
      "could not open source for source.ts:c1; chunk text omitted",
    ]
    const diagnosticDetails = [
      ...diagnostics.slice(0, 80).map((message, index) => ({
        code: "index.skipped_file" as const,
        message,
        filePath: `asset-${index}.png`,
      })),
      { code: "hyde.failed" as const, message: "HyDE failed: upstream timeout" },
      {
        code: "source.read_failed" as const,
        message: "could not open source for source.ts:c1; chunk text omitted",
        filePath: "source.ts",
        chunkId: "c1",
      },
    ]
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: { ...searchStatus(), diagnostics, diagnosticDetails },
        results: [
          {
            filePath: "source.ts",
            language: "typescript",
            range: { byteStart: 0, byteEnd: 100, lineStart: 1, lineEnd: 5 },
            score: 0.9,
            finalScore: 0.95,
            kind: "function",
            breadcrumbs: ["function useful"],
            text: "function useful() {}",
            topology: {
              chunk: { id: "c1", label: "function useful", range: "source.ts:1-5" },
              children: [],
              symbols: ["function useful"],
            },
            retrieval: { mode: "hybrid", vectorRank: 1, bm25Rank: 1 },
          },
        ],
        diagnostics,
        diagnosticDetails,
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })
    hooks.config?.({ tool_output: { max_lines: 200, max_bytes: 12_000 } } as never)

    const result = await semanticSearchTool(hooks).execute({ query: "useful" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(12_000)
    const output = JSON.parse(result.output)
    expect(output.results).toHaveLength(1)
    expect(output.results[0].topology?.chunk?.id ?? output.results[0].id).toBe("c1")
    expect(output.status.diagnostics).toEqual([
      "80 index diagnostics suppressed",
      "HyDE failed: upstream timeout",
      "1 source-read issue while hydrating chunks (sample: could not open source for source.ts:c1; chunk text omitted)",
    ])
    expect(output.diagnostics).toEqual(output.status.diagnostics)
  })

  test("semantic_search_code strips typed diagnostics when no results are present", async () => {
    const diagnostics = ["binary asset omitted: assets/logo.png"]
    const diagnosticDetails = [
      { code: "index.skipped_file" as const, message: diagnostics[0], filePath: "assets/logo.png" },
    ]
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: { ...searchStatus(), diagnostics, diagnosticDetails },
        results: [],
        diagnostics,
        diagnosticDetails,
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const result = await semanticSearchTool(hooks).execute({ query: "missing" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    const output = JSON.parse(result.output)
    expect(Object.hasOwn(output, "diagnosticDetails")).toBe(false)
    expect(Object.hasOwn(output.status, "diagnosticDetails")).toBe(false)
    expect(output.status.diagnostics).toEqual(["1 index diagnostic suppressed"])
    expect(output.diagnostics).toEqual(output.status.diagnostics)
  })

  test("semantic_get_chunk compacts output to configured opencode tool_output limits", async () => {
    const diagnostic =
      "output compacted to fit opencode tool_output limits; narrow semantic_get_chunk args, page children, reduce included relations, or increase opencode tool_output limits"
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    try {
      const source = `${"a".repeat(1200)}\n${"b".repeat(1200)}\n${"c".repeat(1200)}\n`
      await Bun.write(path.join(dir, "source.ts"), source)
      const index = emptyReadyIndex()
      index.metadata.diagnostics = ["assets/logo.png: skipped binary file"]
      index.metadata.worktree = dir
      index.files["source.ts"] = {
        path: "source.ts",
        language: "typescript",
        fingerprint: "fingerprint",
        chunkIds: ["parent", "c1", "child"],
        diagnostics: [],
      }
      index.chunks.parent = {
        id: "parent",
        filePath: "source.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 1200, lineStart: 1, lineEnd: 1 },
        text: "a".repeat(1200),
        nonWhitespaceChars: 1200,
        nodeTypes: ["function_declaration"],
        symbolIds: [],
        childChunkIds: ["c1"],
        embedding: [1],
      }
      index.chunks.c1 = {
        id: "c1",
        filePath: "source.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 1201, byteEnd: 2401, lineStart: 2, lineEnd: 2 },
        text: "b".repeat(1200),
        nonWhitespaceChars: 1200,
        nodeTypes: ["function_declaration"],
        symbolIds: [],
        parentChunkId: "parent",
        childChunkIds: ["child"],
        embedding: [1],
      }
      index.chunks.child = {
        id: "child",
        filePath: "source.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 2402, byteEnd: 3602, lineStart: 3, lineEnd: 3 },
        text: "c".repeat(1200),
        nonWhitespaceChars: 1200,
        nodeTypes: ["function_declaration"],
        symbolIds: [],
        parentChunkId: "c1",
        childChunkIds: [],
        embedding: [1],
      }
      const plugin = createCastPluginForTest({
        createIndexer: () => ({ refresh: async () => index }),
        createStore: () => ({ read: async () => index, write: async () => undefined }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      })
      hooks.config?.({ tool_output: { max_lines: 80, max_bytes: 500 } } as never)

      const tool = semanticGetChunkTool(hooks)
      expect(Object.keys(tool.args)).toEqual(expect.arrayContaining(["childrenOffset", "childrenLimit"]))
      const result = await tool.execute({ id: "c1", includeParents: true, includeChildren: true }, {
        worktree: dir,
        directory: dir,
      } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(500)
      const output = JSON.parse(result.output)
      expect(output.status).toBe("ready")
      expect(output.found).toBe(true)
      expect(output.chunk).toBeUndefined()
      expect(output.diagnostics).toContain(diagnostic)
      expect(output.diagnostics.join("\n")).not.toContain("use semantic_get_chunk for more context")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("semantic_get_chunk uses targeted store hydration without reading the full index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    const calls: string[] = []
    try {
      await Bun.write(path.join(dir, "alpha.ts"), "function alpha() {}\n")
      const diagnostics = [
        "binary asset omitted: assets/logo.png",
        "could not open source for alpha.ts:related; related chunk text omitted",
      ]
      const diagnosticDetails = [
        { code: "index.skipped_file" as const, message: diagnostics[0], filePath: "assets/logo.png" },
        {
          code: "source.read_failed" as const,
          message: diagnostics[1],
          filePath: "alpha.ts",
          chunkId: "related",
        },
      ]
      const metadata = { ...emptyReadyIndex().metadata, worktree: dir, diagnostics, diagnosticDetails }
      const plugin = createCastPluginForTest({
        createStore: () => ({
          read: async () => {
            calls.push("read")
            throw new Error("full index read should not be called")
          },
          write: async () => undefined,
          hydrateChunks: async (chunkIds) => {
            calls.push(`hydrateChunks:${chunkIds.join(",")}`)
            return {
              metadata,
              files: {
                "alpha.ts": {
                  path: "alpha.ts",
                  language: "typescript",
                  fingerprint: "fp",
                  chunkIds: ["alpha"],
                  diagnostics: [],
                },
              },
              chunks: {
                alpha: {
                  id: "alpha",
                  filePath: "alpha.ts",
                  language: "typescript",
                  kind: "function",
                  range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
                  text: "function alpha() {}",
                  nonWhitespaceChars: 17,
                  nodeTypes: [],
                  symbolIds: [],
                  childChunkIds: [],
                },
              },
              symbols: {},
              diagnostics,
              diagnosticDetails,
            }
          },
        }),
        createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
      })

      const result = await semanticGetChunkTool(hooks).execute({ id: "alpha", includeParents: false }, {
        worktree: dir,
        directory: dir,
      } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      const output = JSON.parse(result.output)
      expect(output.chunk.filePath).toBe("alpha.ts")
      expect(output.status.diagnostics).toEqual([
        "1 index diagnostic suppressed",
        "1 source-read issue while hydrating chunks (sample: could not open source for alpha.ts:related; related chunk text omitted)",
      ])
      expect(output.diagnostics).toEqual(output.status.diagnostics)
      expect(calls).toEqual(["hydrateChunks:alpha"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("semantic_get_chunk strips typed diagnostics when chunk is not found", async () => {
    const diagnostics = ["binary asset omitted: assets/logo.png"]
    const diagnosticDetails = [
      { code: "index.skipped_file" as const, message: diagnostics[0], filePath: "assets/logo.png" },
    ]
    const index = emptyReadyIndex()
    index.metadata.diagnostics = diagnostics
    index.metadata.diagnosticDetails = diagnosticDetails
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => index }),
      createStore: () => ({ read: async () => index, write: async () => undefined }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const result = await semanticGetChunkTool(hooks).execute({ id: "missing" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    const output = JSON.parse(result.output)
    expect(Object.hasOwn(output, "diagnosticDetails")).toBe(false)
    expect(Object.hasOwn(output.status, "diagnosticDetails")).toBe(false)
    expect(output.status.diagnostics).toEqual(["1 index diagnostic suppressed", "chunk not found: missing"])
    expect(output.diagnostics).toEqual(output.status.diagnostics)
  })

  test("semantic_search_code hard-caps diagnostics fallback output", async () => {
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: ["x".repeat(2000)],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })
    hooks.config?.({ tool_output: { max_lines: 4, max_bytes: 120 } } as never)

    const result = await semanticSearchTool(hooks).execute({ query: "a" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(120)
    expect(result.output.split("\n").length).toBeLessThanOrEqual(4)
  })

  test("semantic_get_chunk compacts output and updates childrenPage when emitted children are reduced", async () => {
    const childCount = 30
    const sourceLines = ["root", ...Array.from({ length: childCount }, (_, index) => `child-${index}`)]
    const source = `${sourceLines.join("\n")}\n`
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    try {
      await Bun.write(path.join(dir, "source.ts"), source)
      const index = emptyReadyIndex()
      index.metadata.worktree = dir
      index.files["source.ts"] = {
        path: "source.ts",
        language: "typescript",
        fingerprint: "fingerprint",
        chunkIds: ["root", ...Array.from({ length: childCount }, (_, childIndex) => `child-${childIndex}`)],
        diagnostics: [],
      }
      index.chunks.root = {
        id: "root",
        filePath: "source.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 4, lineStart: 1, lineEnd: 1 },
        text: "root",
        nonWhitespaceChars: 4,
        nodeTypes: ["function_declaration"],
        symbolIds: [],
        childChunkIds: Array.from({ length: childCount }, (_, childIndex) => `child-${childIndex}`),
        embedding: [1],
      }
      let byteStart = "root\n".length
      for (let childIndex = 0; childIndex < childCount; childIndex++) {
        const text = `child-${childIndex}`
        index.chunks[`child-${childIndex}`] = {
          id: `child-${childIndex}`,
          filePath: "source.ts",
          language: "typescript",
          kind: "function",
          range: { byteStart, byteEnd: byteStart + text.length, lineStart: childIndex + 2, lineEnd: childIndex + 2 },
          text,
          nonWhitespaceChars: text.length,
          nodeTypes: ["function_declaration"],
          symbolIds: [],
          parentChunkId: "root",
          childChunkIds: [],
          embedding: [1],
        }
        byteStart += text.length + 1
      }
      const plugin = createCastPluginForTest({
        createIndexer: () => ({ refresh: async () => index }),
        createStore: () => ({ read: async () => index, write: async () => undefined }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      })
      hooks.config?.({ tool_output: { max_bytes: 5000 } } as never)

      const result = await semanticGetChunkTool(hooks).execute({ id: "root", includeChildren: true }, {
        worktree: dir,
        directory: dir,
      } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      const output = JSON.parse(result.output)
      expect(output.chunk.related.children.length).toBeLessThan(20)
      expect(output.chunk.related.childrenPage).toMatchObject({
        offset: 0,
        limit: output.chunk.related.children.length,
        total: childCount,
        hasMore: true,
      })
      expect(output.chunk.related.childrenPage.offset + output.chunk.related.childrenPage.limit).toBe(
        output.chunk.related.children.length,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("semantic_search_code returns configuration error when embeddings are missing", async () => {
    const hooks = await castPlugin(input as never, {})
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.title).toBe("Semantic code search is not configured")
    expect(result.output).toContain("embedding.model is required")
    expect(result.metadata).toEqual({ configured: false })
  })

  test("semantic_get_chunk returns configuration error when embeddings are missing", async () => {
    const hooks = await castPlugin(input as never, {})
    const result = await semanticGetChunkTool(hooks).execute({ id: "c1" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.title).toBe("Semantic chunk lookup is not configured")
    expect(result.output).toContain("embedding.model is required")
    expect(result.metadata).toEqual({ configured: false })
  })

  test("semantic_search_code runs with valid embedding config despite non-fatal option diagnostics", async () => {
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      topK: 0,
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.title).toBe("Semantic code search: session")
    expect(result.metadata).toMatchObject({ resultCount: 0 })
  })

  test("store creation failure registers tools and reports unavailable diagnostics", async () => {
    let indexerCreated = false
    const plugin = createCastPluginForTest({
      createStore: () => {
        throw new Error("sqlite-vec failed to load")
      },
      createIndexer: () => {
        indexerCreated = true
        return { refresh: async () => emptyReadyIndex() }
      },
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const searchResult = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    const chunkResult = await semanticGetChunkTool(hooks).execute({ id: "c1" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(indexerCreated).toBe(false)
    expect(typeof searchResult).toBe("object")
    expect(typeof chunkResult).toBe("object")
    if (typeof searchResult === "string" || typeof chunkResult === "string") {
      throw new Error("expected object tool results")
    }
    expect(searchResult.output).toContain("sqlite-vec failed to load")
    expect(searchResult.metadata).toEqual({ configured: true, available: false })
    expect(chunkResult.output).toContain("sqlite-vec failed to load")
    expect(chunkResult.metadata).toEqual({ configured: true, available: false })
  })

  test("lazy store read failure returns unavailable diagnostics from both tools", async () => {
    const store = {
      read: async () => {
        throw new Error("sqlite-vec failed to load lazily")
      },
      readMetadata: async () => {
        throw new Error("sqlite-vec failed to load lazily")
      },
      searchVectorCandidates: async () => [],
      hydrateChunks: async () => emptyHydratedIndex(),
      write: async () => undefined,
    }
    const plugin = createCastPluginForTest({
      createStore: () => store,
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const searchResult = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    const chunkResult = await semanticGetChunkTool(hooks).execute({ id: "c1" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof searchResult).toBe("object")
    expect(typeof chunkResult).toBe("object")
    if (typeof searchResult === "string" || typeof chunkResult === "string") {
      throw new Error("expected object tool results")
    }
    expect(searchResult.output).toContain("sqlite-vec failed to load lazily")
    expect(searchResult.metadata).toEqual({ configured: true, available: false })
    expect(chunkResult.output).toContain("sqlite-vec failed to load lazily")
    expect(chunkResult.metadata).toEqual({ configured: true, available: false })
  })

  test("lazy failed to open database read failure returns unavailable diagnostics from both tools", async () => {
    const store = {
      read: async () => {
        throw new Error("failed to open database")
      },
      readMetadata: async () => {
        throw new Error("failed to open database")
      },
      searchVectorCandidates: async () => [],
      hydrateChunks: async () => emptyHydratedIndex(),
      write: async () => undefined,
    }
    const plugin = createCastPluginForTest({
      createStore: () => store,
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const searchResult = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    const chunkResult = await semanticGetChunkTool(hooks).execute({ id: "c1" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof searchResult).toBe("object")
    expect(typeof chunkResult).toBe("object")
    if (typeof searchResult === "string" || typeof chunkResult === "string") {
      throw new Error("expected object tool results")
    }
    expect(searchResult.output).toContain("failed to open database")
    expect(searchResult.metadata).toEqual({ configured: true, available: false })
    expect(chunkResult.output).toContain("failed to open database")
    expect(chunkResult.metadata).toEqual({ configured: true, available: false })
  })

  test("unrelated lazy read failures throw every time without poisoning store availability", async () => {
    const plugin = createCastPluginForTest({
      createStore: () => ({
        read: async () => {
          throw new Error("permission denied")
        },
        readMetadata: async () => {
          throw new Error("permission denied")
        },
        searchVectorCandidates: async () => [],
        hydrateChunks: async () => emptyHydratedIndex(),
        write: async () => undefined,
      }),
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await expect(
      semanticSearchTool(hooks).execute({ query: "session" }, { worktree: "/repo", directory: "/repo" } as never),
    ).rejects.toThrow("permission denied")
    await expect(
      semanticGetChunkTool(hooks).execute({ id: "c1" }, { worktree: "/repo", directory: "/repo" } as never),
    ).rejects.toThrow("permission denied")
  })

  test("restore failed read failures are not classified as store unavailable", async () => {
    const plugin = createCastPluginForTest({
      createStore: () => ({
        read: async () => {
          throw new Error("restore failed")
        },
        readMetadata: async () => {
          throw new Error("restore failed")
        },
        searchVectorCandidates: async () => [],
        hydrateChunks: async () => emptyHydratedIndex(),
        write: async () => undefined,
      }),
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await expect(
      semanticSearchTool(hooks).execute({ query: "session" }, { worktree: "/repo", directory: "/repo" } as never),
    ).rejects.toThrow("restore failed")
    await expect(
      semanticGetChunkTool(hooks).execute({ id: "c1" }, { worktree: "/repo", directory: "/repo" } as never),
    ).rejects.toThrow("restore failed")
  })

  test("lazy store candidate failure returns unavailable diagnostics from search", async () => {
    const index = emptyReadyIndex()
    const plugin = createCastPluginForTest({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body))
        return Response.json({ data: [{ embedding: String(body.input).includes("session") ? [1, 0] : [0, 1] }] })
      },
      createStore: () => ({
        read: async () => index,
        readMetadata: async () => index.metadata,
        write: async () => undefined,
        searchVectorCandidates: async () => {
          throw new Error("sqlite-vec failed to load for candidates")
        },
        hydrateChunks: async () => emptyHydratedIndex(index),
      }),
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.output).toContain("sqlite-vec failed to load for candidates")
    expect(result.metadata).toEqual({ configured: true, available: false })
  })

  test("HyDE retry store candidate failure returns unavailable diagnostics from search", async () => {
    const index = emptyReadyIndex()
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
    }
    let candidateSearches = 0
    const plugin = createCastPluginForTest({
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        if (url.endsWith("/chat/completions")) {
          return Response.json({ choices: [{ message: { content: "hyde text" } }] })
        }
        return Response.json({ data: [{ embedding: String(body.input).includes("hyde") ? [0, 1] : [1, 0] }] })
      },
      createStore: () => ({
        read: async () => index,
        readMetadata: async () => index.metadata,
        write: async () => undefined,
        searchVectorCandidates: async () => {
          candidateSearches += 1
          if (candidateSearches === 1) {
            return [{ id: "c1", score: 0 }]
          }
          throw new Error("sqlite-vec failed to load during HyDE candidates")
        },
        hydrateChunks: async () => emptyHydratedIndex(index),
      }),
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
      hyde: { baseURL: "https://example.test/v1", model: "hyde", enabled: true, threshold: 0.5 },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.output).toContain("index unavailable")
    expect(result.output).toContain("sqlite-vec failed to load during HyDE candidates")
    expect(result.output).not.toContain("HyDE failed")
    expect(result.metadata).toEqual({ configured: true, available: false })
    expect(candidateSearches).toBe(2)
  })

  test("lazy sqlite-vec background failure from store write is recorded and prevents repeated refresh attempts", async () => {
    let refreshes = 0
    const plugin = createCastPluginForTest({
      createStore: () => ({
        read: async () => emptyReadyIndex(),
        write: async () => {
          throw new Error("sqlite-vec failed to load during write")
        },
      }),
      createIndexer: (input) => ({
        refresh: async () => {
          refreshes += 1
          await input.store.write(emptyReadyIndex())
        },
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.output).toContain("sqlite-vec failed to load during write")
    expect(result.metadata).toEqual({ configured: true, available: false })
    expect(refreshes).toBe(1)
  })

  test("forced refresh surfaces unrelated permission errors", async () => {
    let refreshes = 0
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          if (refreshes === 1) {
            return emptyReadyIndex()
          }
          throw new Error("permission denied")
        },
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await expect(
      semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
        worktree: "/repo",
        directory: "/repo",
      } as never),
    ).rejects.toThrow("permission denied")
    expect(refreshes).toBe(2)
  })

  test("failed forced refresh does not poison later normal searches", async () => {
    let refreshes = 0
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          if (refreshes === 2) {
            throw new Error("permission denied")
          }
          return emptyReadyIndex()
        },
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    await expect(
      semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
        worktree: "/repo",
        directory: "/repo",
      } as never),
    ).rejects.toThrow("permission denied")

    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.title).toBe("Semantic code search: session")
    expect(refreshes).toBe(2)
  })

  test("forced refresh surfaces unrelated database errors from indexer", async () => {
    let refreshes = 0
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          if (refreshes === 1) {
            return emptyReadyIndex()
          }
          throw new Error("database permissions failed")
        },
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await expect(
      semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
        worktree: "/repo",
        directory: "/repo",
      } as never),
    ).rejects.toThrow("database permissions failed")
    expect(refreshes).toBe(2)
  })

  test("background refresh permission errors do not mark the index unavailable", async () => {
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({
        refresh: async () => {
          throw new Error("permission denied")
        },
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.output).not.toContain("index unavailable")
    expect(result.output).not.toContain("permission denied")
    expect(result.metadata).toEqual({
      hydeUsed: false,
      rerankUsed: false,
      resultCount: 0,
      minFinalScore: 0.01,
      filteredCount: 0,
    })
  })

  test("background refresh sqlite scanner bugs do not mark the index unavailable", async () => {
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({
        refresh: async () => {
          throw new Error("sqlite scanner bug")
        },
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.output).not.toContain("index unavailable")
    expect(result.output).not.toContain("sqlite scanner bug")
  })

  test("retrieval database errors are not classified as store unavailable", async () => {
    const plugin = createCastPluginForTest({
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      retrieve: async () => {
        throw new Error("database rerank failed")
      },
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await expect(
      semanticSearchTool(hooks).execute({ query: "session" }, { worktree: "/repo", directory: "/repo" } as never),
    ).rejects.toThrow("database rerank failed")
  })

  test("configured semantic_get_chunk reads the cached index and returns chunk output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    try {
      const source = "export function session() { return 'ok' }\n"
      await Bun.write(path.join(dir, "source.ts"), source)
      const index = emptyReadyIndex()
      index.files["source.ts"] = {
        path: "source.ts",
        language: "typescript",
        fingerprint: "fingerprint",
        chunkIds: ["c1"],
        diagnostics: [],
      }
      index.chunks.c1 = {
        id: "c1",
        filePath: "source.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: source.length, lineStart: 1, lineEnd: 1 },
        text: source,
        nonWhitespaceChars: 30,
        nodeTypes: ["function_declaration"],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1],
      }
      const plugin = createCastPluginForTest({
        createIndexer: () => ({ refresh: async () => index }),
        createStore: () => ({ read: async () => index, write: async () => undefined }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      })

      const result = await semanticGetChunkTool(hooks).execute({ id: "c1" }, { worktree: dir, directory: dir } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      expect(result.title).toBe("Semantic chunk lookup: c1")
      expect(result.metadata).toEqual({ found: true })
      const output = JSON.parse(result.output)
      expect(output.chunk.topology.chunk.id).toBe("c1")
      expect(output.status.diagnostics).toEqual([])
      expect(output.diagnostics).toEqual([])
      await hooks.dispose?.()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("configured semantic_search_code executes retrieval pipeline and returns result metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    const fetchCalls: Array<{ url: string; body: unknown }> = []
    try {
      await Bun.write(path.join(dir, "code.ts"), "export function session() { return 'ok' }\n")
      const plugin = createCastPluginForTest({
        fetch: async (url, init) => {
          const body = JSON.parse(String(init.body))
          fetchCalls.push({ url, body })
          if (url.endsWith("/chat/completions")) {
            return Response.json({ choices: [{ message: { content: "session function" } }] })
          }
          const inputs = (Array.isArray(body.input) ? body.input : [body.input]) as string[]
          return Response.json({
            data: inputs.map((text) => ({
              embedding:
                text === "session function" || String(text).includes("export function session") ? [0, 1] : [1, 0],
            })),
          })
        },
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        cacheDir: path.join(dir, ".cache"),
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
        hyde: { baseURL: "https://example.test/v1", model: "hyde", threshold: 1, enabled: true },
      })

      const result = await semanticSearchTool(hooks).execute(
        { query: "session", topK: 1, includeParents: false, paths: ["code.ts"] },
        { worktree: dir, directory: dir } as never,
      )

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      expect(result.title).toBe("Semantic code search: session")
      expect(result.metadata).toEqual({
        hydeUsed: true,
        rerankUsed: false,
        resultCount: 1,
        minFinalScore: 0.01,
        filteredCount: 0,
      })
      expect(JSON.parse(result.output).results[0].filePath).toBe("code.ts")
      expect(
        fetchCalls.some(
          (call) =>
            call.url.endsWith("/embeddings") &&
            [call.body as { input: string | string[] }].some(({ input }) =>
              (Array.isArray(input) ? input : [input]).some((text) => text.includes("export function session")),
            ),
        ),
      ).toBe(true)
      expect(
        fetchCalls.some(
          (call) => call.url.endsWith("/embeddings") && (call.body as { input: string }).input === "session",
        ),
      ).toBe(true)
      expect(
        fetchCalls.some(
          (call) => call.url.endsWith("/chat/completions") && (call.body as { model: string }).model === "hyde",
        ),
      ).toBe(true)
      await hooks.dispose?.()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("semantic_search_code wires embedding dimensions and store candidates into retrieve", async () => {
    const store = {
      read: async () => emptyReadyIndex(),
      write: async () => undefined,
      searchVectorCandidates: async () => [{ id: "c1", score: 1 }],
    }
    const storeInputs: Array<{ cacheDir: string; cacheKey: string; embeddingDimensions?: number }> = []
    let retrieveIndexStore: unknown
    let retrieveCandidates: unknown
    const plugin = createCastPluginForTest({
      createStore: (input) => {
        storeInputs.push(input)
        return store
      },
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      retrieve: async (input) => {
        retrieveIndexStore = input.indexStore
        retrieveCandidates = await input.indexStore?.searchVectorCandidates([1], 1)
        return {
          status: searchStatus(),
          results: [],
          diagnostics: [],
        }
      },
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
    })

    await semanticSearchTool(hooks).execute({ query: "session" }, { worktree: "/repo", directory: "/repo" } as never)

    expect(storeInputs[0].embeddingDimensions).toBe(2)
    expect(retrieveIndexStore).toBeObject()
    expect(retrieveIndexStore).not.toBe(store)
    expect(retrieveCandidates).toEqual([{ id: "c1", score: 1 }])
  })

  test("semantic_search_code uses store-backed retrieval without reading the full index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    const calls: string[] = []
    try {
      await Bun.write(path.join(dir, "alpha.ts"), "function alpha() {}\n")
      const metadata = { ...emptyReadyIndex().metadata, worktree: dir }
      const plugin = createCastPluginForTest({
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body))
          return Response.json({ data: [{ embedding: String(body.input).includes("alpha") ? [1, 0] : [0, 1] }] })
        },
        createStore: () => ({
          read: async () => {
            calls.push("read")
            throw new Error("full index read should not be called")
          },
          write: async () => undefined,
          readMetadata: async () => {
            calls.push("readMetadata")
            return metadata
          },
          searchVectorCandidates: async () => {
            calls.push("searchVectorCandidates")
            return [{ id: "alpha", score: 0.9 }]
          },
          hydrateChunks: async (chunkIds) => {
            calls.push(`hydrateChunks:${chunkIds.join(",")}`)
            return {
              metadata,
              files: {
                "alpha.ts": {
                  path: "alpha.ts",
                  language: "typescript",
                  fingerprint: "fp",
                  chunkIds: ["alpha"],
                  diagnostics: [],
                },
              },
              chunks: {
                alpha: {
                  id: "alpha",
                  filePath: "alpha.ts",
                  language: "typescript",
                  kind: "function",
                  range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
                  text: "function alpha() {}",
                  nonWhitespaceChars: 17,
                  nodeTypes: [],
                  symbolIds: [],
                  childChunkIds: [],
                },
              },
              symbols: {},
              diagnostics: [],
            }
          },
        }),
        createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
        hyde: { enabled: false },
      })

      const result = await semanticSearchTool(hooks).execute({ query: "alpha", topK: 1 }, {
        worktree: dir,
        directory: dir,
      } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      expect(JSON.parse(result.output).results[0].filePath).toBe("alpha.ts")
      expect(calls).toEqual(["readMetadata", "readMetadata", "searchVectorCandidates", "hydrateChunks:alpha"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("semantic_search_code hydrates lexical-only store candidates through the plugin path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    const calls: string[] = []
    try {
      await Bun.write(path.join(dir, "lexical.ts"), "function lexicalNeedle() {}\n")
      const metadata = { ...emptyReadyIndex().metadata, worktree: dir }
      const plugin = createCastPluginForTest({
        fetch: async () => Response.json({ data: [{ embedding: [1, 0] }] }),
        createStore: () => ({
          read: async () => {
            calls.push("read")
            throw new Error("full index read should not be called")
          },
          write: async () => undefined,
          readMetadata: async () => {
            calls.push("readMetadata")
            return metadata
          },
          searchVectorCandidates: async () => {
            calls.push("searchVectorCandidates")
            return []
          },
          searchLexicalCandidates: async (query: string, topK: number, paths?: string[]) => {
            calls.push(`searchLexicalCandidates:${query}:${topK}:${paths?.join(",") ?? ""}`)
            return [{ id: "lexical", score: 0.8, bm25Score: 0.8 }]
          },
          hydrateChunks: async (chunkIds) => {
            calls.push(`hydrateChunks:${chunkIds.join(",")}`)
            const includeLexical = chunkIds.includes("lexical")
            return {
              metadata,
              files: includeLexical
                ? {
                    "lexical.ts": {
                      path: "lexical.ts",
                      language: "typescript",
                      fingerprint: "fp",
                      chunkIds: ["lexical"],
                      diagnostics: [],
                    },
                  }
                : {},
              chunks: includeLexical
                ? {
                    lexical: {
                      id: "lexical",
                      filePath: "lexical.ts",
                      language: "typescript",
                      kind: "function",
                      range: { byteStart: 0, byteEnd: 27, lineStart: 1, lineEnd: 1 },
                      text: "function lexicalNeedle() {}",
                      nonWhitespaceChars: 24,
                      nodeTypes: [],
                      symbolIds: [],
                      childChunkIds: [],
                      lexical: { length: 1, termFrequencies: { lexicalneedle: 1 } },
                    },
                  }
                : {},
              symbols: {},
              lexical: { documentCount: 1, averageDocumentLength: 1, documentFrequencies: { lexicalneedle: 1 } },
              diagnostics: [],
            }
          },
        }),
        createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      })
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 },
        hyde: { enabled: false },
        retrieval: { hybrid: { enabled: true } },
      })

      const result = await semanticSearchTool(hooks).execute({ query: "lexicalneedle", topK: 1 }, {
        worktree: dir,
        directory: dir,
      } as never)

      expect(typeof result).toBe("object")
      if (typeof result === "string") {
        throw new Error("expected object tool result")
      }
      const output = JSON.parse(result.output)
      expect(output.results[0].filePath).toBe("lexical.ts")
      expect(output.results[0].retrieval.mode).toBe("hybrid")
      expect(output.results[0].retrieval.bm25Rank).toBe(1)
      expect(calls).toEqual([
        "readMetadata",
        "readMetadata",
        "searchVectorCandidates",
        "searchLexicalCandidates:lexicalneedle:8:",
        "hydrateChunks:lexical",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refresh true forces an additional refresh before searching", async () => {
    const refreshes: string[] = []
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: async () => {
          refreshes.push("refresh")
          return emptyReadyIndex()
        },
      }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    await semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(refreshes).toHaveLength(2)
  })

  test("ready metadata skips startup refresh before normal search", async () => {
    let refreshes = 0
    const ready = emptyReadyIndex()
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          return ready
        },
      }),
      createStore: () => ({
        readMetadata: async () => ready.metadata,
        read: async () => {
          throw new Error("full index read should not be needed at startup")
        },
        write: async () => undefined,
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    expect(refreshes).toBe(0)
  })

  test("ready metadata with mismatched scanner options skips startup refresh", async () => {
    let refreshes = 0
    const ready = emptyReadyIndex()
    ready.metadata.includeGlobs = ["src/**/*.ts"]
    ready.metadata.excludeGlobs = ["generated/**"]
    ready.metadata.maxFileBytes = 1024
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          return emptyReadyIndex()
        },
      }),
      createStore: () => ({
        readMetadata: async () => ready.metadata,
        read: async () => emptyReadyIndex(),
        write: async () => undefined,
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(refreshes).toBe(0)
  })

  test("legacy ready metadata skips startup refresh when current scanner options are customized", async () => {
    let refreshes = 0
    const ready = emptyReadyIndex()
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: async () => {
          refreshes += 1
          return emptyReadyIndex()
        },
      }),
      createStore: () => ({
        readMetadata: async () => ready.metadata,
        read: async () => emptyReadyIndex(),
        write: async () => undefined,
      }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      excludeGlobs: ["custom/**"],
    })

    await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(refreshes).toBe(0)
  })

  test("refresh true waits for startup refresh before forcing another refresh", async () => {
    let resolveStartupRefresh: (() => void) | undefined
    const events: string[] = []
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: () =>
          events.length === 0
            ? new Promise((resolve) => {
                events.push("startup started")
                resolveStartupRefresh = () => {
                  events.push("startup finished")
                  resolve(emptyReadyIndex())
                }
              })
            : Promise.resolve(recordEventAndReturnIndex(events, "forced started")),
      }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const executing = semanticSearchTool(hooks).execute({ query: "session", refresh: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(["startup started"])
    resolveStartupRefresh?.()
    await executing

    expect(events).toEqual(["startup started", "startup finished", "forced started"])
  })

  test("concurrent forced refreshes run one at a time after startup refresh", async () => {
    let resolveStartupRefresh: (() => void) | undefined
    let resolveFirstForcedRefresh: (() => void) | undefined
    const events: string[] = []
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: () => {
          if (events.length === 0) {
            events.push("startup started")
            return new Promise((resolve) => {
              resolveStartupRefresh = () => {
                events.push("startup finished")
                resolve(emptyReadyIndex())
              }
            })
          }
          if (!events.includes("forced 1 started")) {
            events.push("forced 1 started")
            return new Promise((resolve) => {
              resolveFirstForcedRefresh = () => {
                events.push("forced 1 finished")
                resolve(emptyReadyIndex())
              }
            })
          }
          events.push("forced 2 started")
          events.push("forced 2 finished")
          return Promise.resolve(emptyReadyIndex())
        },
      }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    const first = semanticSearchTool(hooks).execute({ query: "first", refresh: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    const second = semanticSearchTool(hooks).execute({ query: "second", refresh: true }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(["startup started"])
    resolveStartupRefresh?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(["startup started", "startup finished", "forced 1 started"])
    resolveFirstForcedRefresh?.()
    await Promise.all([first, second])

    expect(events).toEqual([
      "startup started",
      "startup finished",
      "forced 1 started",
      "forced 1 finished",
      "forced 2 started",
      "forced 2 finished",
    ])
  })

  test("background refresh failure does not reject initialization or configured search", async () => {
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: async () => {
          throw new Error("refresh failed")
        },
      }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })
    const result = await semanticSearchTool(hooks).execute({ query: "session" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(typeof result).toBe("object")
    if (typeof result === "string") {
      throw new Error("expected object tool result")
    }
    expect(result.metadata).toEqual({
      hydeUsed: false,
      rerankUsed: false,
      resultCount: 0,
      minFinalScore: 0.01,
      filteredCount: 0,
    })
  })

  test("retrieve wiring passes store-backed index, args, OpenAI calls, and worktree source reader", async () => {
    const index = emptyReadyIndex()
    const seen: {
      input?: unknown
      metadata?: unknown
      embed?: number[]
      hyde?: string
      rerank?: unknown
      source?: string
    } = {}
    const plugin = createCastPluginForTest({
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        if (url.endsWith("/chat/completions")) {
          return Response.json({ choices: [{ message: { content: `hyde:${body.messages[1].content}` } }] })
        }
        if (url.endsWith("/rerank")) {
          return Response.json({ results: [{ index: 0, relevance_score: 0.77 }] })
        }
        return Response.json({ data: [{ embedding: String(body.input).startsWith("hyde:") ? [2] : [1] }] })
      },
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({
        read: async () => index,
        readMetadata: async () => index.metadata,
        searchVectorCandidates: async () => [],
        hydrateChunks: async () => emptyHydratedIndex(index),
        write: async () => undefined,
      }),
      retrieve: async (input) => {
        seen.metadata = await input.indexStore.readMetadata()
        seen.input = input.input
        seen.embed = await input.embed("query text")
        seen.hyde = await input.generateHyde("query text")
        seen.rerank = {
          options: input.options.rerank,
          results: await input.rerank?.("query text", ["document text"]),
        }
        seen.source = await input.readSource("nested/source.ts")
        return {
          status: searchStatus(index.metadata, { hydeUsed: true, rerankUsed: true, candidateCount: 1 }),
          results: [{ filePath: "nested/source.ts" } as never],
          diagnostics: [],
        }
      },
    })
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    try {
      await mkdir(path.join(dir, "nested"))
      await Bun.write(path.join(dir, "nested", "source.ts"), "source text")
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
        hyde: { baseURL: "https://example.test/v1", model: "hyde", enabled: true },
        rerank: { baseURL: "https://openrouter.ai/api/v1", apiKey: "rerank-key", model: "cohere/rerank-4-fast" },
      })
      await semanticSearchTool(hooks).execute(
        { query: "query text", topK: 3, maxContextChars: 50, includeParents: true, paths: ["nested"] },
        { worktree: dir, directory: dir } as never,
      )

      expect(seen.metadata).toBe(index.metadata)
      expect(seen.input).toEqual({
        query: "query text",
        topK: 3,
        maxContextChars: 50,
        includeParents: true,
        paths: ["nested"],
      })
      expect(seen.embed).toEqual([1])
      expect(seen.hyde).toBe("hyde:query text")
      expect(seen.rerank).toEqual({
        options: {
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "rerank-key",
          model: "cohere/rerank-4-fast",
          candidateMultiplier: 4,
        },
        results: [{ index: 0, score: 0.77 }],
      })
      expect(seen.source).toBe("source text")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("retrieve wiring passes parsed hybrid retrieval options", async () => {
    const index = emptyReadyIndex()
    let hybrid: unknown
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => index, write: async () => undefined }),
      retrieve: async (input) => {
        hybrid = input.options.hybrid
        return {
          status: searchStatus(index.metadata),
          results: [],
          diagnostics: [],
        }
      },
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      retrieval: {
        hybrid: {
          enabled: true,
          rrfK: 42,
          vectorCandidateMultiplier: 3,
          bm25CandidateMultiplier: 5,
          vectorWeight: 7,
          bm25Weight: 11,
        },
      },
    })

    await semanticSearchTool(hooks).execute({ query: "query text" }, {
      worktree: "/repo",
      directory: "/repo",
    } as never)

    expect(hybrid).toEqual({
      enabled: true,
      rrfK: 42,
      vectorCandidateMultiplier: 3,
      bm25CandidateMultiplier: 5,
      vectorWeight: 7,
      bm25Weight: 11,
    })
  })

  test("chunking options are plugin indexing options and not semantic_search_code arguments", async () => {
    let indexerOptions: unknown
    const plugin = createCastPluginForTest({
      createIndexer: (input) => {
        indexerOptions = input.options
        return { refresh: async () => emptyReadyIndex() }
      },
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })

    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      chunking: { overlap: 2, expansion: true, minSemanticNonWhitespaceChars: 16 },
    })

    expect(indexerOptions).toEqual({
      maxChunkNonWhitespaceChars: 2000,
      maxFileBytes: 2 * 1024 * 1024,
      includeGlobs: ["**/*"],
      excludeGlobs: expect.arrayContaining(["**/bun.lock"]),
      topK: 5,
      maxContextChars: 12_000,
      chunking: { overlap: 2, expansion: true, minSemanticNonWhitespaceChars: 16 },
      embeddingBatchSize: 16,
    })
    expect(Object.keys(semanticSearchTool(hooks).args)).not.toContain("chunking")
  })

  test("chat.message records the latest model for opencode HyDE fallback", async () => {
    const index = emptyReadyIndex()
    const fakeClient = createFakeClient()
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => index }),
      createStore: () => ({ read: async () => index, write: async () => undefined }),
      retrieve: async (input) => {
        await input.generateHyde("session")
        return {
          status: searchStatus(index.metadata, { hydeUsed: true }),
          results: [],
          diagnostics: [],
        }
      },
    })
    const hooks = await plugin({ ...input, client: fakeClient.client } as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      hyde: { enabled: true, threshold: 1 },
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "s1",
        messageID: "m1",
        agent: "build",
        model: { providerID: "local", modelID: "qwen3.6-27b-mtp" },
      },
      {} as never,
    )
    await semanticSearchTool(hooks).execute({ query: "session" }, {
      sessionID: "s1",
      directory: "/repo",
      worktree: "/repo",
    } as never)

    expect(fakeClient.calls).toEqual([
      {
        type: "create",
        parameters: {
          body: { parentID: "s1", title: "OpenCode Cast HyDE" },
          query: { directory: "/repo" },
        },
      },
      {
        type: "prompt",
        parameters: {
          path: { id: "hyde-session" },
          query: { directory: "/repo" },
          body: {
            model: { providerID: "local", modelID: "qwen3.6-27b-mtp" },
            tools: {},
            system: HYDE_SYSTEM_PROMPT,
            parts: [{ type: "text", text: "session" }],
          },
        },
      },
      { type: "delete", parameters: { path: { id: "hyde-session" }, query: { directory: "/repo" } } },
    ])
  })

  test("opencode HyDE fallback retries prompt when the created session is not immediately visible", async () => {
    const index = emptyReadyIndex()
    const fakeClient = createFakeClient({ promptNotFoundFailures: 1 })
    let hydeText = ""
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => index }),
      createStore: () => ({ read: async () => index, write: async () => undefined }),
      retrieve: async (input) => {
        hydeText = await input.generateHyde("session")
        return {
          status: searchStatus(index.metadata, { hydeUsed: true }),
          results: [],
          diagnostics: [],
        }
      },
    })
    const hooks = await plugin({ ...input, client: fakeClient.client } as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      hyde: { enabled: true, threshold: 1 },
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "s1",
        messageID: "m1",
        agent: "build",
        model: { providerID: "local", modelID: "qwen3.6-27b-mtp" },
      },
      {} as never,
    )
    await semanticSearchTool(hooks).execute({ query: "session" }, {
      sessionID: "s1",
      directory: "/repo",
      worktree: "/repo",
    } as never)

    expect(hydeText).toBe("synthetic session document")
    expect(fakeClient.calls.map((call) => call.type)).toEqual(["create", "prompt", "prompt", "delete"])
  })

  test("opencode HyDE fallback reports a clear error when no model was tracked", async () => {
    const index = emptyReadyIndex()
    let errorMessage = ""
    const fakeClient = createFakeClient()
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => index }),
      createStore: () => ({ read: async () => index, write: async () => undefined }),
      retrieve: async (input) => {
        try {
          await input.generateHyde("session")
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error)
        }
        return {
          status: searchStatus(index.metadata),
          results: [],
          diagnostics: [],
        }
      },
    })
    const hooks = await plugin({ ...input, client: fakeClient.client } as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      hyde: { enabled: true, threshold: 1 },
    })

    await semanticSearchTool(hooks).execute({ query: "session" }, {
      sessionID: "s1",
      directory: "/repo",
      worktree: "/repo",
    } as never)

    expect(errorMessage).toBe("No opencode model is tracked for session s1")
  })

  test("source reader rejects paths outside the plugin worktree", async () => {
    let rejected = false
    let outsidePath = ""
    let outsideRelativePath = ""
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async (input) => {
        await input.readSource(outsideRelativePath).catch(() => {
          rejected = true
        })
        return {
          status: searchStatus(),
          results: [],
          diagnostics: [],
        }
      },
    })
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    try {
      outsidePath = path.join(dir, "..", `${path.basename(dir)}-outside.ts`)
      outsideRelativePath = `../${path.basename(outsidePath)}`
      await Bun.write(outsidePath, "outside")
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      })
      await semanticSearchTool(hooks).execute({ query: "session" }, { worktree: dir, directory: dir } as never)

      expect(rejected).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      if (outsidePath) {
        await rm(outsidePath, { force: true })
      }
    }
  })

  test("source reader rejects in-worktree symlinks that resolve outside the plugin worktree", async () => {
    let rejected = false
    const plugin = createCastPluginForTest({
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async (input) => {
        await input.readSource("secret-link.ts").catch(() => {
          rejected = true
        })
        return {
          status: searchStatus(),
          results: [],
          diagnostics: [],
        }
      },
    })
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "cast-plugin-outside-"))
    try {
      await Bun.write(path.join(outside, "secret.ts"), "outside")
      await symlink(path.join(outside, "secret.ts"), path.join(dir, "secret-link.ts"))
      const hooks = await plugin({ ...input, directory: dir, worktree: dir } as never, {
        embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
      })
      await semanticSearchTool(hooks).execute({ query: "session" }, { worktree: dir, directory: dir } as never)

      expect(rejected).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("cache key is stable and separates embedding space settings and chunk size", async () => {
    const keys: string[] = []
    const plugin = createCastPluginForTest({
      createStore: (input) => {
        keys.push(input.cacheKey)
        return { read: async () => emptyReadyIndex(), write: async () => undefined }
      },
      createIndexer: () => ({ refresh: async () => emptyReadyIndex() }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const baseOptions = {
      cacheDir: "/cache",
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    }

    await plugin(input as never, baseOptions)
    await plugin(input as never, baseOptions)
    await plugin(input as never, {
      ...baseOptions,
      embedding: { ...baseOptions.embedding, baseURL: "https://other.test/v1" },
    })
    await plugin(input as never, { ...baseOptions, embedding: { ...baseOptions.embedding, model: "other" } })
    await plugin(input as never, { ...baseOptions, embedding: { ...baseOptions.embedding, dimensions: 1024 } })
    await plugin(input as never, { ...baseOptions, maxChunkNonWhitespaceChars: 1000 })

    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).not.toBe(keys[0])
    expect(keys[3]).not.toBe(keys[0])
    expect(keys[4]).not.toBe(keys[0])
    expect(keys[5]).not.toBe(keys[0])
  })

  test("dispose clears old refresh promise so later execution does not await it", async () => {
    let resolveRefresh: (() => void) | undefined
    const plugin = createCastPluginForTest({
      createIndexer: () => ({
        refresh: () =>
          new Promise((resolve) => {
            resolveRefresh = () => resolve(emptyReadyIndex())
          }),
      }),
      createStore: () => ({ read: async () => emptyReadyIndex(), write: async () => undefined }),
      retrieve: async () => ({
        status: searchStatus(),
        results: [],
        diagnostics: [],
      }),
    })
    const hooks = await plugin(input as never, {
      embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    })

    await hooks.dispose?.()
    const result = await Promise.race([
      semanticSearchTool(hooks).execute({ query: "session" }, {
        worktree: "/repo",
        directory: "/repo",
      } as never),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 50)),
    ])

    resolveRefresh?.()
    expect(result).not.toBe("timed out")
  })
})

function emptyReadyIndex() {
  const index = createEmptyIndex({
    projectId: "p",
    worktree: "/repo",
    cacheKey: "key",
    maxChunkNonWhitespaceChars: 2000,
  })
  index.metadata.status = "ready"
  return index
}

function emptyHydratedIndex(index = emptyReadyIndex()) {
  return {
    metadata: index.metadata,
    files: index.files,
    chunks: index.chunks,
    symbols: index.symbols,
    lexical: index.lexical,
    diagnostics: [],
  }
}

function recordEventAndReturnIndex(events: string[], event: string) {
  events.push(event)
  return emptyReadyIndex()
}

function searchStatus(
  metadata = emptyReadyIndex().metadata,
  overrides: Partial<{
    hydeUsed: boolean
    rerankUsed: boolean
    minFinalScore: number
    filteredCount: number
    candidateCount: number
  }> = {},
) {
  return {
    ...metadata,
    hydeUsed: false,
    rerankUsed: false,
    minFinalScore: 0.01,
    filteredCount: 0,
    candidateCount: 0,
    ...overrides,
  }
}

function semanticSearchTool(hooks: Awaited<ReturnType<typeof castPlugin>>) {
  const semanticSearchCode = hooks.tool?.semantic_search_code
  if (!semanticSearchCode) {
    throw new Error("semantic_search_code tool was not registered")
  }
  return semanticSearchCode
}

function semanticGetChunkTool(hooks: Awaited<ReturnType<typeof castPlugin>>) {
  const semanticGetChunk = hooks.tool?.semantic_get_chunk
  if (!semanticGetChunk) {
    throw new Error("semantic_get_chunk tool was not registered")
  }
  return semanticGetChunk
}

function createFakeClient(options: { promptNotFoundFailures?: number } = {}) {
  const calls: Array<{ type: "create" | "prompt" | "delete"; parameters: unknown }> = []
  let remainingPromptNotFoundFailures = options.promptNotFoundFailures ?? 0
  return {
    calls,
    client: {
      session: {
        create: async (parameters: {
          body?: { parentID?: string; title?: string }
          query?: { directory?: string }
        }) => {
          calls.push({ type: "create", parameters })
          return { data: { id: "hyde-session" }, error: undefined }
        },
        prompt: async (parameters: {
          path: { id: string }
          query?: { directory?: string }
          body?: {
            model?: { providerID: string; modelID: string }
            tools?: Record<string, boolean>
            system?: string
            parts: Array<{ type: string; text?: string }>
          }
        }) => {
          calls.push({ type: "prompt", parameters })
          if (remainingPromptNotFoundFailures > 0) {
            remainingPromptNotFoundFailures--
            return {
              error: { name: "NotFoundError", data: { message: `Session not found: ${parameters.path.id}` } },
            }
          }
          return { data: { info: {}, parts: [{ type: "text", text: "synthetic session document" }] }, error: undefined }
        },
        delete: async (parameters: { path: { id: string }; query?: { directory?: string } }) => {
          calls.push({ type: "delete", parameters })
          return { data: true, error: undefined }
        },
      },
    },
  }
}
