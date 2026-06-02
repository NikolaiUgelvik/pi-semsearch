import { describe, expect, test } from "bun:test"
import { minimatch } from "minimatch"
import { buildLexicalIndex, tokenizeCodeText } from "./lexical.js"
import { type RetrievalIndexStore, type RetrieveFromStoreInput, retrieveFromStore } from "./retriever.js"
import { createEmptyIndex, searchVectors } from "./store.js"
import type { CastIndex, ChunkRecord, HybridRetrievalOptions, RerankOptions } from "./types.js"

const hybridOptions = (overrides: Partial<HybridRetrievalOptions> = {}): HybridRetrievalOptions => ({
  enabled: true,
  rrfK: 60,
  vectorCandidateMultiplier: 2,
  bm25CandidateMultiplier: 2,
  vectorWeight: 1,
  bm25Weight: 4,
  ...overrides,
})

const rerankOptions = (overrides: Partial<RerankOptions> = {}): RerankOptions => ({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "key",
  model: "cohere/rerank-4-fast",
  candidateMultiplier: 4,
  ...overrides,
})

const TEST_GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/

function addLexicalStats(index: CastIndex) {
  const lexical = buildLexicalIndex(index.chunks, index.symbols)
  index.lexical = lexical.lexical
  index.chunks = lexical.chunks
}

type RetrieveFromIndexInput = Omit<RetrieveFromStoreInput, "indexStore"> & {
  index: CastIndex
  indexStore?: RetrievalIndexStore
}

async function retrieveFromIndex({ index, indexStore, ...input }: RetrieveFromIndexInput) {
  return retrieveFromStore({ ...input, indexStore: indexStore ?? indexStoreFromIndex(index) })
}

function indexStoreFromIndex(index: CastIndex): RetrievalIndexStore {
  return {
    readMetadata: async () => index.metadata,
    searchVectorCandidates: async (queryEmbedding, topK, paths) => {
      const vectors = Object.values(index.chunks)
        .filter((chunk) => chunk.embedding && testPathMatches(chunk.filePath, paths))
        .map((chunk) => ({ id: chunk.id, vector: chunk.embedding ?? [] }))
      return searchVectors(queryEmbedding, vectors, topK)
    },
    searchLexicalCandidates: async (query, topK, paths) => {
      const chunks = Object.values(index.chunks).filter((chunk) => testPathMatches(chunk.filePath, paths))
      const lexical = buildLexicalIndex(Object.fromEntries(chunks.map((chunk) => [chunk.id, chunk])), index.symbols)
      const queryTerms = new Set(tokenizeCodeText(query))
      return Object.values(lexical.chunks)
        .flatMap((chunk) => {
          const score = [...queryTerms].reduce((sum, term) => sum + (chunk.lexical?.termFrequencies[term] ?? 0), 0)
          return score > 0 ? [{ id: chunk.id, score, bm25Score: score }] : []
        })
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
        .slice(0, topK)
    },
    hydrateChunks: async (chunkIds) => {
      const ids = chunkIdsWithTopology(index, chunkIds)
      const chunks = Object.fromEntries(ids.flatMap((id) => (index.chunks[id] ? [[id, index.chunks[id]]] : [])))
      const filePaths = [...new Set(Object.values(chunks).map((chunk) => chunk.filePath))]
      const files = Object.fromEntries(
        filePaths.map((filePath) => [
          filePath,
          index.files[filePath] ?? {
            path: filePath,
            language: chunksByFilePath(chunks, filePath)[0]?.language ?? "typescript",
            fingerprint: "test",
            chunkIds: Object.values(index.chunks)
              .filter((chunk) => chunk.filePath === filePath)
              .map((chunk) => chunk.id),
            diagnostics: [],
          },
        ]),
      )
      const symbolIds = [...new Set(Object.values(chunks).flatMap((chunk) => chunk.symbolIds))]
      return {
        metadata: index.metadata,
        files,
        chunks,
        symbols: Object.fromEntries(symbolIds.flatMap((id) => (index.symbols[id] ? [[id, index.symbols[id]]] : []))),
        lexical: index.lexical,
        diagnostics: index.metadata.diagnostics,
      }
    },
  }
}

function testPathMatches(filePath: string, paths?: string[]) {
  return !paths || paths.length === 0 || paths.some((path) => testPathFilterMatches(filePath, path))
}

function testPathFilterMatches(filePath: string, path: string) {
  if (TEST_GLOB_SYNTAX_PATTERN.test(path)) {
    return minimatch(filePath, path, { dot: true })
  }
  return filePath === path || filePath.startsWith(path.endsWith("/") ? path : `${path}/`)
}

function chunkIdsWithTopology(index: CastIndex, chunkIds: string[]) {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of chunkIds) {
    if (!seen.has(id) && index.chunks[id]) {
      ids.push(id)
      seen.add(id)
    }
  }
  for (const id of ids.slice()) {
    const chunk = index.chunks[id]
    if (!chunk) {
      continue
    }
    for (const relatedId of [
      chunk.parentChunkId,
      ...chunk.childChunkIds,
      chunk.previousSiblingChunkId,
      chunk.nextSiblingChunkId,
    ]) {
      if (relatedId && !seen.has(relatedId)) {
        ids.push(relatedId)
        seen.add(relatedId)
      }
    }
  }
  return ids
}

function chunksByFilePath(chunks: Record<string, ChunkRecord>, filePath: string) {
  return Object.values(chunks).filter((chunk) => chunk.filePath === filePath)
}

describe("retrieve", () => {
  test("uses store vector candidates without hydrated embeddings", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
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

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
      indexStore: {
        ...indexStoreFromIndex(index),
        searchVectorCandidates: async () => [{ id: "c1", score: 0.75 }],
      },
    })

    expect(output.results[0].filePath).toBe("a.ts")
    expect(output.results[0].score).toBe(0.75)
  })

  test("store-backed retrieval does not require a hydrated full index", async () => {
    const output = await retrieveFromStore({
      input: { query: "alpha", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function alpha() {}",
      indexStore: {
        readMetadata: async () => ({
          schemaVersion: 1,
          projectId: "p",
          worktree: "/repo",
          cacheKey: "key",
          maxChunkNonWhitespaceChars: 2000,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
          updatedAt: 1,
          status: "ready",
          diagnostics: [],
        }),
        searchVectorCandidates: async () => [{ id: "c1", score: 0.9 }],
        hydrateChunks: async () => ({
          metadata: {
            schemaVersion: 1,
            projectId: "p",
            worktree: "/repo",
            cacheKey: "key",
            maxChunkNonWhitespaceChars: 2000,
            chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
            updatedAt: 1,
            status: "ready",
            diagnostics: [],
          },
          files: {
            "a.ts": { path: "a.ts", language: "typescript", fingerprint: "fp", chunkIds: ["c1"], diagnostics: [] },
          },
          chunks: {
            c1: {
              id: "c1",
              filePath: "a.ts",
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
        }),
      },
    })

    expect(output.results.map((result) => result.filePath)).toEqual(["a.ts"])
  })

  test("store-backed retrieval uses HyDE vector candidates", async () => {
    const hydratedChunkIds: string[][] = []
    const output = await retrieveFromStore({
      input: { query: "alpha", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
      embed: async (text) => (text === "alpha" ? [1, 0] : [0, 1]),
      generateHyde: async () => "hyde alpha",
      readSource: async (filePath) => (filePath === "hyde.ts" ? "function hydeAlpha() {}" : "function alpha() {}"),
      indexStore: {
        readMetadata: async () => ({
          schemaVersion: 1,
          projectId: "p",
          worktree: "/repo",
          cacheKey: "key",
          maxChunkNonWhitespaceChars: 2000,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
          updatedAt: 1,
          status: "ready",
          diagnostics: [],
        }),
        searchVectorCandidates: async (vector) =>
          vector[0] === 1 ? [{ id: "initial", score: 0.1 }] : [{ id: "hyde", score: 0.95 }],
        hydrateChunks: async (chunkIds) => {
          hydratedChunkIds.push(chunkIds)
          return {
            metadata: {
              schemaVersion: 1,
              projectId: "p",
              worktree: "/repo",
              cacheKey: "key",
              maxChunkNonWhitespaceChars: 2000,
              chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
              updatedAt: 1,
              status: "ready",
              diagnostics: [],
            },
            files: {
              "initial.ts": {
                path: "initial.ts",
                language: "typescript",
                fingerprint: "initial-fp",
                chunkIds: ["initial"],
                diagnostics: [],
              },
              "hyde.ts": {
                path: "hyde.ts",
                language: "typescript",
                fingerprint: "hyde-fp",
                chunkIds: ["hyde"],
                diagnostics: [],
              },
            },
            chunks: {
              initial: {
                id: "initial",
                filePath: "initial.ts",
                language: "typescript",
                kind: "function",
                range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
                text: "function alpha() {}",
                nonWhitespaceChars: 17,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
              },
              hyde: {
                id: "hyde",
                filePath: "hyde.ts",
                language: "typescript",
                kind: "function",
                range: { byteStart: 0, byteEnd: 24, lineStart: 1, lineEnd: 1 },
                text: "function hydeAlpha() {}",
                nonWhitespaceChars: 21,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
              },
            },
            symbols: {},
            diagnostics: [],
          }
        },
      },
    })

    expect(output.status.hydeUsed).toBe(true)
    expect(output.results.map((result) => result.filePath)).toEqual(["hyde.ts"])
    expect(hydratedChunkIds).toEqual([["hyde"]])
  })

  test("store-backed retrieval de-duplicates hydrated diagnostics preserving order", async () => {
    const metadata = {
      schemaVersion: 1,
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
      updatedAt: 1,
      status: "ready" as const,
      diagnostics: ["metadata warning", "shared warning"],
    }

    const output = await retrieveFromStore({
      input: { query: "alpha", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function alpha() {}",
      indexStore: {
        readMetadata: async () => metadata,
        searchVectorCandidates: async () => [{ id: "c1", score: 0.9 }],
        hydrateChunks: async () => ({
          metadata,
          files: {
            "a.ts": { path: "a.ts", language: "typescript", fingerprint: "fp", chunkIds: ["c1"], diagnostics: [] },
          },
          chunks: {
            c1: {
              id: "c1",
              filePath: "a.ts",
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
          diagnostics: ["shared warning", "hydration warning"],
        }),
      },
    })

    expect(output.status.diagnostics).toEqual(["metadata warning", "shared warning", "hydration warning"])
    expect(output.diagnostics).toEqual(["metadata warning", "shared warning", "hydration warning"])
  })

  test("store-backed HyDE rethrows index unavailable errors", async () => {
    const unavailable = new Error("index unavailable")
    unavailable.name = "IndexUnavailableError"

    await expect(
      retrieveFromStore({
        input: { query: "alpha", topK: 1, includeParents: true, maxContextChars: 100 },
        options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
        embed: async (text) => (text === "alpha" ? [1, 0] : [0, 1]),
        generateHyde: async () => "hyde alpha",
        readSource: async () => "function alpha() {}",
        indexStore: {
          readMetadata: async () => ({
            schemaVersion: 1,
            projectId: "p",
            worktree: "/repo",
            cacheKey: "key",
            maxChunkNonWhitespaceChars: 2000,
            chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
            updatedAt: 1,
            status: "ready",
            diagnostics: [],
          }),
          searchVectorCandidates: async (vector) => {
            if (vector[0] === 1) {
              return [{ id: "initial", score: 0.1 }]
            }
            throw unavailable
          },
          hydrateChunks: async () => {
            throw new Error("hydrate should not run")
          },
        },
      }),
    ).rejects.toThrow("index unavailable")
  })

  test("store-backed hybrid fuses SQLite lexical candidates without hydrated lexical stats", async () => {
    const hydratedIds: string[][] = []
    const metadata = {
      schemaVersion: 1,
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
      updatedAt: 1,
      status: "ready" as const,
      diagnostics: [],
    }
    const output = await retrieveFromStore({
      input: { query: "exactNeedle", topK: 2, maxContextChars: 100 },
      options: { topK: 2, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 }, hybrid: hybridOptions() },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) =>
        filePath === "lexical.ts" ? "function exactNeedle() {}" : "function vector() {}",
      indexStore: {
        readMetadata: async () => metadata,
        searchVectorCandidates: async () => [{ id: "vector", score: 0.9 }],
        searchLexicalCandidates: async () => [{ id: "lexical", score: 12, bm25Score: 7 }],
        hydrateChunks: async (ids) => {
          hydratedIds.push(ids)
          return {
            metadata,
            files: {
              "vector.ts": {
                path: "vector.ts",
                language: "typescript",
                fingerprint: "fp",
                chunkIds: ["vector"],
                diagnostics: [],
              },
              "lexical.ts": {
                path: "lexical.ts",
                language: "typescript",
                fingerprint: "fp",
                chunkIds: ["lexical"],
                diagnostics: [],
              },
            },
            chunks: {
              vector: {
                id: "vector",
                filePath: "vector.ts",
                language: "typescript",
                kind: "function" as const,
                range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
                text: "function vector() {}",
                nonWhitespaceChars: 16,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
              },
              lexical: {
                id: "lexical",
                filePath: "lexical.ts",
                language: "typescript",
                kind: "function" as const,
                range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
                text: "function exactNeedle() {}",
                nonWhitespaceChars: 22,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
              },
            },
            symbols: {},
            diagnostics: [],
          }
        },
      },
    })

    expect(hydratedIds[0].sort()).toEqual(["lexical", "vector"])
    expect(output.diagnostics).not.toContain(
      "hybrid retrieval requested but lexical data is unavailable; using vector-only retrieval",
    )
    expect(output.results.map((result) => result.topology.chunk.id).sort()).toEqual(["lexical", "vector"])
    expect(output.results.find((result) => result.topology.chunk.id === "lexical")?.retrieval).toMatchObject({
      mode: "hybrid",
      bm25Rank: 1,
      bm25Score: 7,
    })
  })

  test("store-backed hybrid retrieval prefetches the hybrid vector candidate count", async () => {
    const vectorTopKs: number[] = []
    const metadata = {
      schemaVersion: 1,
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
      updatedAt: 1,
      status: "ready" as const,
      diagnostics: [],
    }
    await retrieveFromStore({
      input: { query: "exactNeedle", topK: 2, maxContextChars: 100 },
      options: {
        topK: 2,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions({ vectorCandidateMultiplier: 8 }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "",
      indexStore: {
        readMetadata: async () => metadata,
        searchVectorCandidates: async (_vector, topK) => {
          vectorTopKs.push(topK)
          return Array.from({ length: topK }, (_, index) => ({ id: `vector-${index}`, score: 1 - index / topK }))
        },
        searchLexicalCandidates: async () => [{ id: "lexical", score: 10, bm25Score: 10 }],
        hydrateChunks: async (ids) => {
          const chunks = Object.fromEntries(
            ids.map((id) => [
              id,
              {
                id,
                filePath: `${id}.ts`,
                language: "typescript",
                kind: "function" as const,
                range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
                text: id === "lexical" ? "function exactNeedle() {}" : `function ${id.replace("-", "")}() {}`,
                nonWhitespaceChars: 20,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
              },
            ]),
          )
          const lexical = buildLexicalIndex(chunks, {})
          return {
            metadata,
            files: Object.fromEntries(
              ids.map((id) => [
                `${id}.ts`,
                { path: `${id}.ts`, language: "typescript", fingerprint: "fp", chunkIds: [id], diagnostics: [] },
              ]),
            ),
            chunks: lexical.chunks,
            symbols: {},
            lexical: lexical.lexical,
            diagnostics: [],
          }
        },
      },
    })

    expect(vectorTopKs[0]).toBe(16)
  })

  test("store-backed hybrid hydrates only ranked vector candidates", async () => {
    const vectorTopKs: number[] = []
    const metadata = {
      schemaVersion: 1,
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
      updatedAt: 1,
      status: "ready" as const,
      diagnostics: [],
    }
    const output = await retrieveFromStore({
      input: { query: "exactVectorTieNeedle", topK: 1, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions({ vectorCandidateMultiplier: 1, bm25CandidateMultiplier: 1 }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "",
      indexStore: {
        readMetadata: async () => metadata,
        searchVectorCandidates: async (_vector, topK) => {
          vectorTopKs.push(topK)
          const candidates = [{ id: "a-unrelated", score: 1 }]
          return topK > 1 ? [...candidates, { id: "z-exact", score: 1 }] : candidates
        },
        searchLexicalCandidates: async () => [],
        hydrateChunks: async (ids) => {
          const chunks = Object.fromEntries(
            ids.map((id) => [
              id,
              {
                id,
                filePath: `${id}.ts`,
                language: "typescript",
                kind: "function" as const,
                range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
                text: id === "z-exact" ? "function exactVectorTieNeedle() {}" : "function unrelated() {}",
                nonWhitespaceChars: 20,
                nodeTypes: [],
                symbolIds: [],
                childChunkIds: [],
                embedding: [1, 0],
              },
            ]),
          )
          const lexical = buildLexicalIndex(chunks, {})
          return {
            metadata,
            files: Object.fromEntries(
              ids.map((id) => [
                `${id}.ts`,
                { path: `${id}.ts`, language: "typescript", fingerprint: "fp", chunkIds: [id], diagnostics: [] },
              ]),
            ),
            chunks: lexical.chunks,
            symbols: {},
            lexical: lexical.lexical,
            diagnostics: [],
          }
        },
      },
    })

    expect(vectorTopKs[0]).toBe(1)
    expect(output.results[0].topology.chunk.id).toBe("a-unrelated")
  })

  test("returns normal embedding results without HyDE above threshold", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
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
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => {
        throw new Error("not called")
      },
      readSource: async () => "function a() {}",
    })

    expect(output.status.hydeUsed).toBe(false)
    expect(output.results[0].filePath).toBe("a.ts")
  })

  test("returns labeled topology in search results", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    const functionText = "function parseOptions() {\n  return {}\n}"
    const source = `${functionText}\n\nconst value = 1\n`
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "parseOptions",
      kind: "function",
      filePath: "src/options.ts",
      range: { byteStart: 0, byteEnd: functionText.length, lineStart: 1, lineEnd: 3 },
      childSymbolIds: [],
    }
    index.symbols.sChild = {
      id: "sChild",
      name: "readOptions",
      kind: "function",
      filePath: "src/options.ts",
      range: { byteStart: 26, byteEnd: 35, lineStart: 2, lineEnd: 2 },
      childSymbolIds: [],
    }
    index.symbols.sPrevious = {
      id: "sPrevious",
      name: "loadDefaults",
      kind: "function",
      filePath: "src/options.ts",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      childSymbolIds: [],
    }
    index.symbols.sNext = {
      id: "sNext",
      name: "formatOptions",
      kind: "function",
      filePath: "src/options.ts",
      range: { byteStart: 41, byteEnd: 55, lineStart: 5, lineEnd: 5 },
      childSymbolIds: [],
    }
    index.chunks.parent = {
      id: "parent",
      filePath: "src/options.ts",
      language: "typescript",
      kind: "file",
      range: { byteStart: 0, byteEnd: source.trimEnd().length, lineStart: 1, lineEnd: 6 },
      text: source.trimEnd(),
      nonWhitespaceChars: 44,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: ["c1"],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "src/options.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: functionText.length, lineStart: 1, lineEnd: 3 },
      text: functionText,
      nonWhitespaceChars: 33,
      nodeTypes: [],
      symbolIds: ["s1"],
      parentChunkId: "parent",
      childChunkIds: ["child"],
      previousSiblingChunkId: "previous",
      nextSiblingChunkId: "next",
      embedding: [1, 0],
    }
    index.chunks.child = {
      id: "child",
      filePath: "src/options.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: 26, byteEnd: 35, lineStart: 2, lineEnd: 2 },
      text: "return {}",
      nonWhitespaceChars: 8,
      nodeTypes: [],
      symbolIds: ["sChild"],
      parentChunkId: "c1",
      childChunkIds: [],
    }
    index.chunks.previous = {
      id: "previous",
      filePath: "src/options.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "defaults()",
      nonWhitespaceChars: 10,
      nodeTypes: [],
      symbolIds: ["sPrevious"],
      childChunkIds: [],
    }
    index.chunks.next = {
      id: "next",
      filePath: "src/options.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 41, byteEnd: 55, lineStart: 5, lineEnd: 5 },
      text: "formatOptions()",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: ["sNext"],
      childChunkIds: [],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "parseOptions", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => source,
    })

    expect(output.results[0].topology).toEqual({
      chunk: { id: "c1", label: "function parseOptions", range: "src/options.ts:1-3" },
      parent: { id: "parent", label: "file src/options.ts", range: "src/options.ts:1-6" },
      children: [{ id: "child", label: "function readOptions", range: "src/options.ts:2" }],
      previousSibling: { id: "previous", label: "function loadDefaults", range: "src/options.ts:1" },
      nextSibling: { id: "next", label: "function formatOptions", range: "src/options.ts:5" },
      symbols: ["function parseOptions"],
    })
  })

  test("filters retrieval candidates by exact paths and directory prefixes", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks["src/a.ts"] = {
      id: "src/a.ts",
      filePath: "src/a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks["src/nested/b.ts"] = {
      id: "src/nested/b.ts",
      filePath: "src/nested/b.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function b() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.9, 0],
    }
    index.chunks["src/c.ts"] = {
      id: "src/c.ts",
      filePath: "src/c.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function c() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.7, 0.7],
    }
    index.chunks["test/c.ts"] = {
      id: "test/c.ts",
      filePath: "test/c.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function c() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.8, 0],
    }

    const exact = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 3, includeParents: true, maxContextChars: 100, paths: ["test/c.ts"] },
      options: { topK: 3, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath].text,
    })
    const directory = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 3, includeParents: true, maxContextChars: 100, paths: ["src/"] },
      options: { topK: 3, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath].text,
    })
    const glob = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 3, includeParents: true, maxContextChars: 100, paths: ["src/**/*.ts"] },
      options: { topK: 3, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath].text,
    })
    const bracketGlob = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 3, includeParents: true, maxContextChars: 100, paths: ["src/[ab].ts"] },
      options: { topK: 3, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath].text,
    })

    expect(exact.results.map((result) => result.filePath)).toEqual(["test/c.ts"])
    expect(directory.results.map((result) => result.filePath)).toEqual(["src/a.ts", "src/nested/b.ts", "src/c.ts"])
    expect(glob.results.map((result) => result.filePath)).toEqual(["src/a.ts", "src/nested/b.ts", "src/c.ts"])
    expect(bracketGlob.results.map((result) => result.filePath)).toEqual(["src/a.ts"])
  })

  test("uses HyDE when best score is below threshold", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
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
      embedding: [0, 1],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
      embed: async (text) => (text === "hyde text" ? [0, 1] : [1, 0]),
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.status.hydeUsed).toBe(true)
    expect(output.status.bestScore).toBe(0)
    expect(output.results[0].score).toBe(0)
    expect(output.results[0].finalScore).toBe(1)
  })

  test("falls back to initial results with diagnostics when HyDE fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["existing"],
    })
    index.metadata.status = "ready"
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
      embedding: [0, 1],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100, minFinalScore: 0 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => {
        throw new Error("hyde exploded")
      },
      readSource: async () => "function a() {}",
    })

    expect(output.status.hydeUsed).toBe(false)
    expect(output.results[0].topology.chunk.id).toBe("c1")
    expect(output.results[0].score).toBe(0)
    expect(output.results[0].finalScore).toBe(0)
    expect(output.diagnostics).toContain("existing")
    expect(output.diagnostics).toContain("HyDE failed: hyde exploded")
  })

  test("uses HyDE when initial search has no embedded chunks", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "",
    })

    expect(output.status.hydeUsed).toBe(true)
    expect(output.status.bestScore).toBeUndefined()
    expect(output.results).toEqual([])
  })

  test("filters zero-score results with the default minFinalScore", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 16, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "nonsense", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results).toEqual([])
    expect(output.status.minFinalScore).toBe(0.01)
    expect(output.status.filteredCount).toBe(1)
    expect(output.status.candidateCount).toBe(1)
  })

  test("allows callers to lower minFinalScore", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 16, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "nonsense", topK: 1, includeParents: true, maxContextChars: 100, minFinalScore: 0 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results).toHaveLength(1)
    expect(output.results[0].finalScore).toBe(0)
    expect(output.status.minFinalScore).toBe(0)
    expect(output.status.filteredCount).toBe(0)
    expect(output.status.candidateCount).toBe(1)
  })

  test("allows callers to raise minFinalScore", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 16, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100, minFinalScore: 1.1 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results).toEqual([])
    expect(output.status.minFinalScore).toBe(1.1)
    expect(output.status.filteredCount).toBe(1)
    expect(output.status.candidateCount).toBe(1)
  })

  test("clamps negative minFinalScore to zero", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 16, lineStart: 1, lineEnd: 1 },
      text: "function a() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "nonsense", topK: 1, includeParents: true, maxContextChars: 100, minFinalScore: -1 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results).toHaveLength(1)
    expect(output.results[0].finalScore).toBe(0)
    expect(output.status.minFinalScore).toBe(0)
    expect(output.status.filteredCount).toBe(0)
    expect(output.status.candidateCount).toBe(1)
  })

  test("reranks vector candidates after initial ranking", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
      text: "function first() {}",
      nonWhitespaceChars: 18,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.c2 = {
      id: "c2",
      filePath: "b.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
      text: "function second() {}",
      nonWhitespaceChars: 19,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.9, Math.sqrt(0.19)],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "best match", topK: 1, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        rerank: rerankOptions({ candidateMultiplier: 2 }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      rerank: async (_query, documents) => {
        expect(documents).toEqual([
          "a.ts:1\nkind: function\nfunction first() {}",
          "b.ts:1\nkind: function\nfunction second() {}",
        ])
        return [
          { index: 1, score: 0.99 },
          { index: 0, score: 0.1 },
        ]
      },
      readSource: async (filePath) => index.chunks[filePath === "a.ts" ? "c1" : "c2"].text,
    })

    expect(output.status.rerankUsed).toBe(true)
    expect(output.results.map((result) => result.topology.chunk.id)).toEqual(["c2"])
    expect(output.results[0].score).toBe(0.9)
    expect(output.results[0].finalScore).toBe(0.99)
    expect(output.results[0].retrieval).toMatchObject({
      mode: "vector",
      vectorRank: 2,
      rerankRank: 1,
      rerankScore: 0.99,
    })
  })

  test("falls back to pre-rerank results with diagnostics when rerank fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
      text: "function first() {}",
      nonWhitespaceChars: 18,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "best match", topK: 1, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        rerank: rerankOptions(),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      rerank: async () => {
        throw new Error("provider unavailable")
      },
      readSource: async () => "function first() {}",
    })

    expect(output.status.rerankUsed).toBe(false)
    expect(output.results[0].topology.chunk.id).toBe("c1")
    expect(output.results[0].finalScore).toBe(1)
    expect(output.results[0].retrieval).toMatchObject({ mode: "vector", vectorRank: 1 })
    expect(output.results[0].retrieval?.rerankRank).toBeUndefined()
    expect(output.diagnostics.at(-1)).toBe("Rerank failed: provider unavailable")
  })

  test("preserves omitted candidates after partial rerank responses", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
      text: "function first() {}",
      nonWhitespaceChars: 18,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.c2 = {
      id: "c2",
      filePath: "b.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
      text: "function second() {}",
      nonWhitespaceChars: 19,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.9, Math.sqrt(0.19)],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "best match", topK: 2, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 2,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        rerank: rerankOptions({ candidateMultiplier: 1 }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      rerank: async () => [{ index: 1, score: 0.99 }],
      readSource: async (filePath) => index.chunks[filePath === "a.ts" ? "c1" : "c2"].text,
    })

    expect(output.results.map((result) => result.topology.chunk.id)).toEqual(["c2", "c1"])
    expect(output.results.map((result) => result.finalScore)).toEqual([0.99, 1])
    expect(output.results[0].retrieval?.rerankRank).toBe(1)
    expect(output.results[1].retrieval?.rerankRank).toBeUndefined()
  })

  test("uses active score when HyDE promotes a result outside initial candidates", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
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
      embedding: [0.9, Math.sqrt(0.19)],
    }
    index.chunks.c2 = {
      id: "c2",
      filePath: "b.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function b() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.8, 0.6],
    }
    index.chunks.c3 = {
      id: "c3",
      filePath: "c.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function c() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.7, Math.sqrt(0.51)],
    }
    index.chunks.c4 = {
      id: "c4",
      filePath: "d.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
      text: "function d() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.1, Math.sqrt(0.99)],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: true, threshold: 0.95 } },
      embed: async (text) => (text === "hyde text" ? [0, 1] : [1, 0]),
      generateHyde: async () => "hyde text",
      readSource: async () => "function d() {}",
    })

    expect(output.results[0].topology.chunk.id).toBe("c4")
    expect(output.results[0].finalScore).toBeGreaterThan(0.99)
    expect(output.results[0].score).toBe(output.results[0].finalScore)
  })

  test("returns metadata diagnostics when no chunks have embeddings", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["embedding failed: boom"],
    })
    index.metadata.status = "ready"
    index.files["a.ts"] = {
      path: "a.ts",
      language: "typescript",
      fingerprint: "abc",
      chunkIds: ["c1"],
      diagnostics: ["embedding failed: boom"],
    }
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
      embeddingError: "boom",
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results).toEqual([])
    expect(output.diagnostics).toContain("embedding failed: boom")
  })

  function searchParentContextFixture() {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    const source = "class Parser {\n  parse() {}\n}\n"
    const parentText = source.trimEnd()
    const childText = "parse() {}"
    const parentRange = { byteStart: 0, byteEnd: parentText.length, lineStart: 1, lineEnd: 3 }
    index.metadata.status = "ready"
    index.symbols.sParent = {
      id: "sParent",
      name: "Parser",
      kind: "class",
      filePath: "src/parser.ts",
      range: parentRange,
      childSymbolIds: [],
    }
    index.chunks.parent = {
      id: "parent",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "class",
      range: parentRange,
      text: parentText,
      nonWhitespaceChars: 22,
      nodeTypes: [],
      symbolIds: ["sParent"],
      childChunkIds: ["child"],
    }
    index.chunks.child = {
      id: "child",
      filePath: "src/parser.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 17, byteEnd: 27, lineStart: 2, lineEnd: 2 },
      text: childText,
      nonWhitespaceChars: 9,
      nodeTypes: [],
      symbolIds: ["sParent"],
      parentChunkId: "parent",
      childChunkIds: [],
      embedding: [1, 0],
    }

    return { childText, index, parentRange, parentText, source }
  }

  test("omits parent context from search results by default", async () => {
    const { childText, index, source } = searchParentContextFixture()

    const output = await retrieveFromIndex({
      index,
      input: { query: "parse", topK: 1, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => source,
    })

    expect(output.results[0].text).toBe(childText)
    expect(output.results[0].breadcrumbs).toEqual(["class Parser"])
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.results[0].parentRange).toBeUndefined()
    expect(output.results[0].topology.parent).toEqual({
      id: "parent",
      label: "class Parser",
      range: "src/parser.ts:1-3",
    })
  })

  test("includes parent context from search results when explicitly requested", async () => {
    const { index, parentRange, parentText, source } = searchParentContextFixture()

    const output = await retrieveFromIndex({
      index,
      input: { query: "parse", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => source,
    })

    expect(output.results[0].parentText).toBe(parentText)
    expect(output.results[0].parentRange).toEqual(parentRange)
  })

  test("returns empty result text and omits parent context when source read fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "A",
      kind: "class",
      filePath: "a.ts",
      range: { byteStart: 20, byteEnd: 40, lineStart: 2, lineEnd: 4 },
      childSymbolIds: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 30, byteEnd: 38, lineStart: 3, lineEnd: 3 },
      text: "a() {}",
      nonWhitespaceChars: 5,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => {
        throw new Error("read failed")
      },
    })

    expect(output.results[0].breadcrumbs).toEqual(["class A"])
    expect(output.results[0].text).toBe("")
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.results[0].parentRange).toBeUndefined()
    expect(output.diagnostics).toContain("source read failed for a.ts; parent context omitted")
  })

  test("does not return stale hydrated chunk text when source read fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "A",
      kind: "class",
      filePath: "a.ts",
      range: { byteStart: 0, byteEnd: 22, lineStart: 1, lineEnd: 3 },
      childSymbolIds: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 12, byteEnd: 18, lineStart: 2, lineEnd: 2 },
      text: "a() {}",
      nonWhitespaceChars: 5,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => {
        throw new Error("read failed")
      },
    })

    expect(output.results[0].text).toBe("")
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.results[0].parentRange).toBeUndefined()
    expect(output.diagnostics).toContain("source read failed for a.ts; parent context omitted")
  })

  test("returns empty text with diagnostics when hydrated chunk text is unavailable and source read fails", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
      diagnostics: ["source read failed for a.ts; chunk text unavailable"],
    })
    index.metadata.status = "ready"
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 15, lineStart: 1, lineEnd: 1 },
      text: "",
      nonWhitespaceChars: 0,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => {
        throw new Error("read failed")
      },
    })

    expect(output.results[0].text).toBe("")
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.diagnostics).toContain("source read failed for a.ts; chunk text unavailable")
    expect(output.diagnostics).toContain("source read failed for a.ts; parent context omitted")
  })

  test("omits parent text and range when source no longer matches indexed chunk", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "A",
      kind: "class",
      filePath: "a.ts",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 3 },
      childSymbolIds: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 12, byteEnd: 18, lineStart: 2, lineEnd: 2 },
      text: "a() {}",
      nonWhitespaceChars: 5,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: { topK: 1, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "class A {\n  z() {}\n}\n",
    })

    expect(output.results[0].breadcrumbs).toEqual(["class A"])
    expect(output.results[0].text).toBe("")
    expect(output.results[0].parentText).toBeUndefined()
    expect(output.results[0].parentRange).toBeUndefined()
    expect(output.diagnostics).toContain("source mismatch for a.ts:c1; parent context omitted")
  })

  test("reads shared result source once per search", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.files["same.ts"] = {
      path: "same.ts",
      language: "typescript",
      fingerprint: "test",
      chunkIds: ["one", "two"],
      diagnostics: [],
    }
    index.chunks.one = {
      id: "one",
      filePath: "same.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
      text: "export const one = 1",
      nonWhitespaceChars: 16,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0, 0],
    }
    index.chunks.two = {
      id: "two",
      filePath: "same.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: 21, byteEnd: 41, lineStart: 2, lineEnd: 2 },
      text: "export const two = 2",
      nonWhitespaceChars: 16,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.9, 0, 0],
    }
    addLexicalStats(index)
    let reads = 0
    const output = await retrieveFromIndex({
      index,
      input: { query: "const", topK: 2 },
      options: { topK: 2, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0, 0],
      generateHyde: async () => "",
      rerank: undefined,
      readSource: async () => {
        reads += 1
        return "export const one = 1\nexport const two = 2\n"
      },
    })

    expect(output.results.map((result) => result.filePath)).toEqual(["same.ts", "same.ts"])
    expect(reads).toBe(1)
  })

  test("reports shared source read failed diagnostic once per file", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.files["same.ts"] = {
      path: "same.ts",
      language: "typescript",
      fingerprint: "test",
      chunkIds: ["one", "two"],
      diagnostics: [],
    }
    index.chunks.one = {
      id: "one",
      filePath: "same.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
      text: "export const one = 1",
      nonWhitespaceChars: 16,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0, 0],
    }
    index.chunks.two = {
      id: "two",
      filePath: "same.ts",
      language: "typescript",
      kind: "block",
      range: { byteStart: 21, byteEnd: 41, lineStart: 2, lineEnd: 2 },
      text: "export const two = 2",
      nonWhitespaceChars: 16,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.9, 0, 0],
    }
    addLexicalStats(index)

    const output = await retrieveFromIndex({
      index,
      input: { query: "const", topK: 2 },
      options: { topK: 2, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0, 0],
      generateHyde: async () => "",
      rerank: undefined,
      readSource: async () => {
        throw new Error("read failed")
      },
    })

    const message = "source read failed for same.ts; parent context omitted"
    expect(output.results.map((result) => result.filePath)).toEqual(["same.ts", "same.ts"])
    expect(output.diagnostics.filter((diagnostic) => diagnostic === message)).toHaveLength(1)
    expect(output.diagnosticDetails?.filter((diagnostic) => diagnostic.message === message)).toHaveLength(1)
    expect(output.diagnosticDetails?.find((diagnostic) => diagnostic.message === message)).toMatchObject({
      code: "source.read_failed",
      filePath: "same.ts",
    })
  })

  test("suppresses duplicate parent context for repeated parent ranges", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "A",
      kind: "class",
      filePath: "a.ts",
      range: { byteStart: 0, byteEnd: 29, lineStart: 1, lineEnd: 4 },
      childSymbolIds: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 12, byteEnd: 18, lineStart: 2, lineEnd: 2 },
      text: "a() {}",
      nonWhitespaceChars: 5,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.c2 = {
      id: "c2",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: { byteStart: 21, byteEnd: 27, lineStart: 3, lineEnd: 3 },
      text: "b() {}",
      nonWhitespaceChars: 5,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [0.9, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 2, includeParents: true, maxContextChars: 100 },
      options: { topK: 2, maxContextChars: 100, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "class A {\n  a() {}\n  b() {}\n}\n",
    })

    expect(output.results[0].parentText).toBe("class A {\n  a() {}\n  b() {}\n}")
    expect(output.results[0].parentRange).toEqual(index.symbols.s1.range)
    expect(output.results[1].breadcrumbs).toEqual(["class A"])
    expect(output.results[1].parentText).toBeUndefined()
    expect(output.results[1].parentRange).toBeUndefined()
  })

  test("suppresses compact parent excerpts for repeated parent ranges", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    const source = "class A {\n  aLongName() {}\n  bLongName() {}\n}\n"
    index.metadata.status = "ready"
    index.symbols.s1 = {
      id: "s1",
      name: "A",
      kind: "class",
      filePath: "a.ts",
      range: { byteStart: 0, byteEnd: source.trimEnd().length, lineStart: 1, lineEnd: 4 },
      childSymbolIds: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: {
        byteStart: source.indexOf("aLongName"),
        byteEnd: source.indexOf("aLongName") + "aLongName() {}".length,
        lineStart: 2,
        lineEnd: 2,
      },
      text: "aLongName() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.c2 = {
      id: "c2",
      filePath: "a.ts",
      language: "typescript",
      kind: "method",
      range: {
        byteStart: source.indexOf("bLongName"),
        byteEnd: source.indexOf("bLongName") + "bLongName() {}".length,
        lineStart: 3,
        lineEnd: 3,
      },
      text: "bLongName() {}",
      nonWhitespaceChars: 13,
      nodeTypes: [],
      symbolIds: ["s1"],
      childChunkIds: [],
      embedding: [0.9, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 2, includeParents: true, maxContextChars: 24 },
      options: { topK: 2, maxContextChars: 24, hyde: { enabled: false, threshold: 0.5 } },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => source,
    })

    expect(output.results[0].parentText).toContain("aLongName")
    expect(output.results[1].parentText).toBeUndefined()
    expect(output.results[1].parentRange).toBeUndefined()
  })

  test("parallel hybrid returns a BM25-only exact identifier match when vector score is weak", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.semantic = {
      id: "semantic",
      filePath: "src/semantic.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 25, lineStart: 1, lineEnd: 1 },
      text: "function nearbyConcept() {}",
      nonWhitespaceChars: 24,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.exact = {
      id: "exact",
      filePath: "src/exact.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 36, lineStart: 1, lineEnd: 1 },
      text: "function throwCriticalParserError() {}",
      nonWhitespaceChars: 35,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }
    addLexicalStats(index)

    const output = await retrieveFromIndex({
      index,
      input: { query: "throwCriticalParserError", topK: 1, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions({ vectorCandidateMultiplier: 1, bm25CandidateMultiplier: 1 }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath === "src/semantic.ts" ? "semantic" : "exact"].text,
    })

    expect(output.results.map((result) => result.topology.chunk.id)).toContain("exact")
    expect(output.results.find((result) => result.topology.chunk.id === "exact")?.retrieval).toMatchObject({
      mode: "hybrid",
      bm25Rank: 1,
    })
    expect(output.results[0].retrieval?.vectorRank).toBeUndefined()
  })

  test("hybrid respects path filters for BM25 candidates", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.src = {
      id: "src",
      filePath: "src/allowed.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 28, lineStart: 1, lineEnd: 1 },
      text: "function allowedNeedle() {}",
      nonWhitespaceChars: 27,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }
    index.chunks.test = {
      id: "test",
      filePath: "test/blocked.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 35, lineStart: 1, lineEnd: 1 },
      text: "function allowedNeedleBlocked() {}",
      nonWhitespaceChars: 34,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    addLexicalStats(index)

    const output = await retrieveFromIndex({
      index,
      input: { query: "allowedNeedleBlocked", topK: 3, includeParents: true, maxContextChars: 100, paths: ["src/"] },
      options: {
        topK: 3,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions(),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function allowedNeedle() {}",
    })

    expect(output.results.map((result) => result.filePath)).toEqual(["src/allowed.ts"])
  })

  test("store-backed hybrid can use lexical candidates without hydrated lexical stats", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
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
      embedding: [1, 0],
    }

    const output = await retrieveFromIndex({
      index,
      input: { query: "a", topK: 1, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions(),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function a() {}",
    })

    expect(output.results[0].retrieval).toMatchObject({ mode: "hybrid", vectorRank: 1, bm25Rank: 1 })
    expect(output.diagnostics).not.toContain(
      "hybrid retrieval requested but lexical data is unavailable; using vector-only retrieval",
    )
  })

  test("hybrid disabled preserves vector-only behavior", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.vector = {
      id: "vector",
      filePath: "vector.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 24, lineStart: 1, lineEnd: 1 },
      text: "function vectorOnly() {}",
      nonWhitespaceChars: 23,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.lexical = {
      id: "lexical",
      filePath: "lexical.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 32, lineStart: 1, lineEnd: 1 },
      text: "function exactDisabledHybrid() {}",
      nonWhitespaceChars: 31,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }
    addLexicalStats(index)

    const output = await retrieveFromIndex({
      index,
      input: { query: "exactDisabledHybrid", topK: 1, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 1,
        maxContextChars: 100,
        hyde: { enabled: false, threshold: 0.5 },
        hybrid: hybridOptions({ enabled: false }),
      },
      embed: async () => [1, 0],
      generateHyde: async () => "hyde text",
      readSource: async () => "function vectorOnly() {}",
    })

    expect(output.results.map((result) => result.topology.chunk.id)).toEqual(["vector"])
    expect(output.results[0].retrieval).toEqual({ mode: "vector", vectorRank: 1 })
  })

  test("HyDE-triggered hybrid uses HyDE vector candidates while preserving BM25 fusion", async () => {
    const index = createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "key",
      maxChunkNonWhitespaceChars: 2000,
    })
    index.metadata.status = "ready"
    index.chunks.initial = {
      id: "initial",
      filePath: "initial.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 24, lineStart: 1, lineEnd: 1 },
      text: "function initial() {}",
      nonWhitespaceChars: 23,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [1, 0],
    }
    index.chunks.hyde = {
      id: "hyde",
      filePath: "hyde.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
      text: "function hyde() {}",
      nonWhitespaceChars: 19,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0, 1],
    }
    index.chunks.exact = {
      id: "exact",
      filePath: "exact.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 34, lineStart: 1, lineEnd: 1 },
      text: "function rareHybridNeedle() {}",
      nonWhitespaceChars: 33,
      nodeTypes: [],
      symbolIds: [],
      childChunkIds: [],
      embedding: [0.1, 0],
    }
    addLexicalStats(index)

    const output = await retrieveFromIndex({
      index,
      input: { query: "rareHybridNeedle", topK: 2, includeParents: true, maxContextChars: 100 },
      options: {
        topK: 2,
        maxContextChars: 100,
        hyde: { enabled: true, threshold: 0.5 },
        hybrid: hybridOptions({ vectorWeight: 1, bm25Weight: 1 }),
      },
      embed: async (text) => (text === "hyde text" ? [0, 1] : [0, 0]),
      generateHyde: async () => "hyde text",
      readSource: async (filePath) => index.chunks[filePath.replace(".ts", "")].text,
    })

    expect(output.status.hydeUsed).toBe(true)
    expect(output.results.map((result) => result.topology.chunk.id)).toContain("hyde")
    expect(output.results.map((result) => result.topology.chunk.id)).toContain("exact")
    expect(output.results.find((result) => result.topology.chunk.id === "exact")?.retrieval?.bm25Rank).toBe(1)
  })
})
