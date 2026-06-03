import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { Database } from "../test-utils/sqlite.js"
import { parseOptions } from "./options.js"
import { createIndexer as createScannerIndexer } from "./scanner.js"
import { createEmptyIndex, createIndexStore } from "./store.js"
import type { CastIndex, ChunkingOptions, ChunkRecord, FileRecord, SymbolRecord } from "./types.js"

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 }
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

type CreateIndexerInput = Parameters<typeof createScannerIndexer>[0]
type TestCreateIndexerInput = Omit<CreateIndexerInput, "options"> & {
  options: Omit<CreateIndexerInput["options"], "chunking" | "maxFileBytes"> & {
    chunking?: ChunkingOptions
    maxFileBytes?: number
  }
}
type ResumableStore = ReturnType<typeof createIndexStore> & {
  writeFileResult(
    runId: string,
    fileResult: { file: FileRecord; chunks: Record<string, ChunkRecord>; symbols: Record<string, SymbolRecord> },
  ): Promise<void>
}
type BatchResumableStore = ResumableStore & {
  writeFileResults(
    runId: string,
    fileResults: Array<{
      file: FileRecord
      chunks: Record<string, ChunkRecord>
      symbols: Record<string, SymbolRecord>
    }>,
  ): Promise<void>
}
const createIndexer = (input: TestCreateIndexerInput) =>
  createScannerIndexer({
    ...input,
    options: {
      ...input.options,
      chunking: input.options.chunking ?? DEFAULT_CHUNKING_OPTIONS,
      maxFileBytes: input.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    },
  })

function readActiveRunId(cacheDir: string) {
  const db = new Database(path.join(cacheDir, "key", "index.sqlite"))
  try {
    return (db.query("select value from meta where key = 'active_run_id'").get() as { value: string }).value
  } finally {
    db.close()
  }
}

async function testFingerprint(filePath: string) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex")
}

function createMemoryStore(initial?: CastIndex): CreateIndexerInput["store"] {
  let index =
    initial ??
    createEmptyIndex({
      projectId: "p",
      worktree: "/repo",
      cacheKey: "memory",
      maxChunkNonWhitespaceChars: 2000,
      chunking: DEFAULT_CHUNKING_OPTIONS,
    })
  return {
    read: async () => index,
    write: async (next) => {
      index = next
    },
  }
}

function createReadyIndex(input: {
  worktree: string
  includeGlobs?: string[]
  excludeGlobs?: string[]
  diagnostics?: string[]
  diagnosticDetails?: CastIndex["metadata"]["diagnosticDetails"]
}) {
  const index = createEmptyIndex({
    projectId: "p",
    worktree: input.worktree,
    cacheKey: "memory",
    maxChunkNonWhitespaceChars: 2000,
    chunking: DEFAULT_CHUNKING_OPTIONS,
    diagnostics: input.diagnostics,
  })
  index.metadata.status = "ready"
  index.metadata.maxFileBytes = DEFAULT_MAX_FILE_BYTES
  index.metadata.includeGlobs = input.includeGlobs ?? ["**/*.ts"]
  index.metadata.excludeGlobs = input.excludeGlobs ?? []
  index.metadata.diagnosticDetails = input.diagnosticDetails
  return index
}

function addStaleFile(index: CastIndex, filePath: string) {
  const chunkId = `${filePath}:chunk`
  index.files[filePath] = {
    path: filePath,
    language: "typescript",
    fingerprint: "stale",
    chunkIds: [chunkId],
    diagnostics: [],
  }
  index.chunks[chunkId] = {
    id: chunkId,
    filePath,
    language: "typescript",
    kind: "fallback",
    range: { byteStart: 0, byteEnd: 5, lineStart: 1, lineEnd: 1 },
    text: "stale",
    nonWhitespaceChars: 5,
    nodeTypes: [],
    symbolIds: [],
    childChunkIds: [],
    embedding: [1, 0],
    lexical: { length: 1, termFrequencies: { stale: 1 } },
  }
  index.lexical = { documentCount: 1, averageDocumentLength: 1, documentFrequencies: { stale: 1 } }
}

function disableBatchFileResultWrites(store: ResumableStore) {
  const storeWithoutBatch = store as Partial<BatchResumableStore>
  storeWithoutBatch.writeFileResults = undefined
}

describe("createIndexer", () => {
  test("batches embeddings across files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      const batches: string[][] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          embeddingBatchSize: 2,
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => {
          throw new Error("single embedding should not be called")
        },
        embedBatch: async (texts) => {
          batches.push(texts)
          return texts.map((_, index) => [index + 1, 0])
        },
      })

      const index = await indexer.refresh()

      expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"])
      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refreshFile reparses and embeds only the requested file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      const store = createMemoryStore()
      const parsedPaths: string[] = []
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async (filePath) => {
          parsedPaths.push(path.relative(dir, filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async (text) => {
          embeddedTexts.push(text)
          return [embeddedTexts.length, 0]
        },
      })

      await indexer.refresh()
      parsedPaths.length = 0
      embeddedTexts.length = 0
      await writeFile(path.join(dir, "a.ts"), "export const a = 3\n")

      const index = await indexer.refreshFile("a.ts")

      expect(parsedPaths).toEqual(["a.ts"])
      expect(embeddedTexts).toHaveLength(1)
      expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"])
      expect(Object.values(index.chunks).some((chunk) => chunk.filePath === "a.ts" && chunk.text.includes("3"))).toBe(
        true,
      )
      expect(Object.values(index.chunks).some((chunk) => chunk.filePath === "b.ts" && chunk.text.includes("2"))).toBe(
        true,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refreshFile removes deleted files from an existing index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      await rm(path.join(dir, "a.ts"))

      const index = await indexer.refreshFile("a.ts")

      expect(Object.keys(index.files)).toEqual(["b.ts"])
      expect(Object.values(index.chunks).every((chunk) => chunk.filePath !== "a.ts")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refreshFile removes symlink targets without indexing linked content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-outside-"))
    try {
      await writeFile(path.join(dir, "link.ts"), "export const local = 1\n")
      await writeFile(path.join(outside, "secret.ts"), "export const secret = 'outside'\n")
      const parsedPaths: string[] = []
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(),
        parse: async (filePath) => {
          parsedPaths.push(path.relative(dir, filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()
      await rm(path.join(dir, "link.ts"))
      await symlink(path.join(outside, "secret.ts"), path.join(dir, "link.ts"))
      parsedPaths.length = 0
      embeddedTexts.length = 0

      const index = await indexer.refreshFile("link.ts")

      expect(parsedPaths).toEqual([])
      expect(embeddedTexts).toEqual([])
      expect(index.files["link.ts"]).toBeUndefined()
      expect(Object.values(index.chunks).every((chunk) => chunk.filePath !== "link.ts")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("refreshFile removes paths under symlinked directories without indexing linked content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-outside-"))
    try {
      await writeFile(path.join(outside, "a.ts"), "export const secret = 'outside'\n")
      await symlink(outside, path.join(dir, "linkdir"))
      const initial = createReadyIndex({ worktree: dir })
      const targetPath = path.join("linkdir", "a.ts")
      addStaleFile(initial, targetPath)
      const parsedPaths: string[] = []
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(initial),
        parse: async (filePath) => {
          parsedPaths.push(path.relative(dir, filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      const index = await indexer.refreshFile(targetPath)

      expect(parsedPaths).toEqual([])
      expect(embeddedTexts).toEqual([])
      expect(index.files[targetPath]).toBeUndefined()
      expect(Object.values(index.chunks).every((chunk) => chunk.filePath !== targetPath)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("refreshFile removes excluded, gitignored, and default-ignored targets without parsing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await mkdir(path.join(dir, "generated"), { recursive: true })
      await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true })
      await writeFile(path.join(dir, "generated", "a.ts"), "export const generated = 1\n")
      await writeFile(path.join(dir, "ignored.ts"), "export const ignored = 1\n")
      await writeFile(path.join(dir, "node_modules", "pkg", "a.ts"), "export const dependency = 1\n")
      await writeFile(path.join(dir, ".gitignore"), "ignored.ts\n")
      const initial = createReadyIndex({ worktree: dir, excludeGlobs: ["generated"] })
      addStaleFile(initial, "generated/a.ts")
      addStaleFile(initial, "ignored.ts")
      addStaleFile(initial, path.join("node_modules", "pkg", "a.ts"))
      const parsedPaths: string[] = []
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: ["generated"],
        },
        store: createMemoryStore(initial),
        parse: async (filePath) => {
          parsedPaths.push(path.relative(dir, filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      const excludedPath = "generated/a.ts"
      const gitignoredPath = "ignored.ts"
      const defaultIgnoredPath = path.join("node_modules", "pkg", "a.ts")
      const afterExcluded = await indexer.refreshFile(excludedPath)
      const afterGitignored = await indexer.refreshFile(gitignoredPath)
      const afterDefaultIgnored = await indexer.refreshFile(defaultIgnoredPath)
      const skippedPaths = new Set([excludedPath, gitignoredPath, defaultIgnoredPath])

      expect(parsedPaths).toEqual([])
      expect(embeddedTexts).toEqual([])
      expect(afterExcluded.files[excludedPath]).toBeUndefined()
      expect(afterGitignored.files[gitignoredPath]).toBeUndefined()
      expect(afterDefaultIgnored.files[defaultIgnoredPath]).toBeUndefined()
      expect(Object.values(afterDefaultIgnored.chunks).every((chunk) => !skippedPaths.has(chunk.filePath))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refreshFile persists removal of stale path diagnostics even without file records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const initial = createReadyIndex({
        worktree: dir,
        diagnostics: ["large.ts: skipped file over maxFileBytes (10 > 1)"],
        diagnosticDetails: [
          {
            code: "index.skipped_file",
            message: "large.ts: skipped file over maxFileBytes (10 > 1)",
            filePath: "large.ts",
          },
        ],
      })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(initial),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      const index = await indexer.refreshFile("large.ts")

      expect(index.metadata.diagnostics).toEqual([])
      expect(index.metadata.diagnosticDetails).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refreshFile propagates processing errors without partially persisting stale record removal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      const stored = createReadyIndex({ worktree: dir })
      addStaleFile(stored, "a.ts")
      let writes = 0
      const controller = new AbortController()
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => stored,
          write: async () => {
            writes += 1
          },
        },
        parse: async () => {
          controller.abort(new Error("stop before persist"))
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      })

      await expect(indexer.refreshFile("a.ts", controller.signal)).rejects.toThrow("stop before persist")

      expect(writes).toBe(0)
      expect(stored.files["a.ts"]).toBeDefined()
      expect(Object.values(stored.chunks).some((chunk) => chunk.filePath === "a.ts")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("captures parsed root once before embedding chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const source = "export function example() { return 1 }\n"
      await writeFile(path.join(dir, "example.ts"), source)
      let rootReads = 0
      const root = {
        type: "program",
        startIndex: 0,
        endIndex: source.length,
        children: [
          {
            type: "function_declaration",
            startIndex: 0,
            endIndex: source.length,
            children: [],
          },
        ],
      }
      const parsed = {
        language: "typescript",
        get root() {
          rootReads += 1
          return root
        },
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(),
        parse: async () => parsed,
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(rootReads).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("aborts before embedding batches after parsing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "example.ts"), "export const example = 1\n")
      const controller = new AbortController()
      let embedBatchCalled = false
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(),
        parse: async () => {
          controller.abort()
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          throw new Error("single embedding should not be called")
        },
        embedBatch: async () => {
          embedBatchCalled = true
          return [[1, 0]]
        },
      })

      await expect(indexer.refresh(controller.signal)).rejects.toThrow("operation was aborted")
      expect(embedBatchCalled).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("limits in-flight embedding batches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(
        path.join(dir, "source.txt"),
        Array.from({ length: 8 }, (_, index) => `chunk ${index}`).join("\n\n"),
      )
      let activeBatches = 0
      let maxActiveBatches = 0
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 5,
          includeGlobs: ["**/*.txt"],
          excludeGlobs: [],
          embeddingBatchSize: 1,
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "text", root: undefined }),
        embed: async () => {
          throw new Error("single embedding should not be called")
        },
        embedBatch: async (texts) => {
          activeBatches++
          maxActiveBatches = Math.max(maxActiveBatches, activeBatches)
          await new Promise((resolve) => setTimeout(resolve, 1))
          activeBatches--
          return texts.map(() => [1, 0])
        },
      })

      await indexer.refresh()

      expect(maxActiveBatches).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("limits embedding batches to configured concurrency", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "many.txt"), Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"))
      let active = 0
      let maxActive = 0

      await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 8,
          includeGlobs: ["**/*.txt"],
          excludeGlobs: [],
          embeddingBatchSize: 1,
          embeddingBatchConcurrency: 2,
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "text", root: undefined }),
        embedBatch: async (texts) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          active -= 1
          return texts.map(() => [1, 0, 0])
        },
        embed: async () => [1, 0, 0],
      }).refresh()

      expect(maxActive).toBeLessThanOrEqual(2)
      expect(maxActive).toBeGreaterThan(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("processes independent files concurrently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let activeParses = 0
      let maxActiveParses = 0
      let releaseImmediately = false
      const releaseParse: Array<() => void> = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          embeddingBatchSize: 2,
        },
        store: createMemoryStore(),
        parse: async () => {
          activeParses++
          maxActiveParses = Math.max(maxActiveParses, activeParses)
          if (!releaseImmediately) {
            await new Promise<void>((resolve) => releaseParse.push(resolve))
          }
          activeParses--
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
        embedBatch: async (texts) => texts.map(() => [1, 0]),
      })

      const refresh = indexer.refresh()
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 1000
        const check = () => {
          if (releaseParse.length >= 2 || Date.now() >= deadline) {
            resolve()
            return
          }
          setTimeout(check, 1)
        }
        check()
      })
      releaseImmediately = true
      for (const release of releaseParse.splice(0)) {
        release()
      }
      await refresh

      expect(maxActiveParses).toBeGreaterThan(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("waits for in-flight file workers before rejecting refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a-slow.ts"), "export const slow = 1\n")
      await writeFile(path.join(dir, "b-fail.ts"), "export const fail = 2\n")
      let releaseSlowParse: (() => void) | undefined
      let writeFailureStarted: (() => void) | undefined
      const writeFailure = new Promise<void>((resolve) => {
        writeFailureStarted = resolve
      })
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      disableBatchFileResultWrites(store)
      const originalWriteFileResult = store.writeFileResult.bind(store)
      store.writeFileResult = async (runId, fileResult) => {
        if (fileResult.file.path === "b-fail.ts") {
          writeFailureStarted?.()
          throw new Error("simulated file write failure")
        }
        await originalWriteFileResult(runId, fileResult)
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async (filePath) => {
          if (path.basename(filePath) === "a-slow.ts") {
            await new Promise<void>((resolve) => {
              releaseSlowParse = resolve
            })
          }
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      })

      const refresh = indexer.refresh()
      await writeFailure

      const settledBeforeSlowWorker = await Promise.race([
        refresh.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10)),
      ])
      expect(settledBeforeSlowWorker).toBe(false)

      releaseSlowParse?.()
      await expect(refresh).rejects.toThrow("simulated file write failure")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reads changed file contents once while fingerprinting and indexing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      const fileText = "export const a = 1\n"
      await writeFile(filePath, fileText)
      let parseSource = ""
      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: createMemoryStore(),
        parse: async (_filePath, source) => {
          parseSource = source
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      }).refresh()

      expect(parseSource).toBe(fileText)
      expect(index.files["a.ts"].fingerprint).toBe(await testFingerprint(filePath))
      expect(Object.values(index.chunks)[0].text).toBe(fileText)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resumes a first indexing run after completed files were persisted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let parseCalls = 0
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      disableBatchFileResultWrites(store)
      const originalWriteFileResult = store.writeFileResult.bind(store)
      let fileWrites = 0
      store.writeFileResult = async (runId, fileResult) => {
        await originalWriteFileResult(runId, fileResult)
        fileWrites++
        if (fileWrites === 1) {
          throw new Error("simulated crash after first file")
        }
      }
      const options = {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: [],
      }
      const makeIndexer = () =>
        createIndexer({
          worktree: dir,
          options,
          store,
          parse: async () => {
            parseCalls++
            return { language: "typescript", root: undefined }
          },
          embed: async () => {
            embedCalls++
            return [1, 0]
          },
        })

      await expect(makeIndexer().refresh()).rejects.toThrow("simulated crash after first file")
      store.writeFileResult = originalWriteFileResult
      const index = await makeIndexer().refresh()

      expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"])
      expect(parseCalls).toBe(3)
      expect(embedCalls).toBe(3)
      expect(
        (await createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }).read()).metadata.status,
      ).toBe("ready")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("prefers batched file-result writes when the run store supports them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as BatchResumableStore
      const originalWriteFileResults = store.writeFileResults.bind(store)
      let batchWrites = 0
      let singleWrites = 0
      store.writeFileResults = async (runId, fileResults) => {
        batchWrites++
        await originalWriteFileResults(runId, fileResults)
      }
      store.writeFileResult = async () => {
        singleWrites++
        throw new Error("single file writes should not be called")
      }

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      }).refresh()

      expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"])
      expect(batchWrites).toBeGreaterThan(0)
      expect(singleWrites).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("flushes pending batched file results before rejecting after another worker fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let aEmbedded: (() => void) | undefined
      const aEmbeddedPromise = new Promise<void>((resolve) => {
        aEmbedded = resolve
      })
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as BatchResumableStore
      const originalGetCompletedFile = store.getCompletedFile.bind(store)
      const originalWriteFileResults = store.writeFileResults.bind(store)
      const batchWrites: string[][] = []
      store.getCompletedFile = async (runId, filePath, fingerprint) => {
        if (filePath === "b.ts") {
          await aEmbeddedPromise
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error("simulated completed-file lookup failure")
        }
        return originalGetCompletedFile(runId, filePath, fingerprint)
      }
      store.writeFileResults = async (runId, fileResults) => {
        batchWrites.push(fileResults.map((fileResult) => fileResult.file.path))
        await originalWriteFileResults(runId, fileResults)
      }
      store.writeFileResult = async () => {
        throw new Error("single file writes should not be called")
      }

      await expect(
        createIndexer({
          worktree: dir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
          },
          store,
          parse: async () => ({ language: "typescript", root: undefined }),
          embed: async (text) => {
            if (text.includes("path: a.ts")) {
              aEmbedded?.()
            }
            return [1, 0]
          },
        }).refresh(),
      ).rejects.toThrow("simulated completed-file lookup failure")

      expect(batchWrites).toEqual([["a.ts"]])
      const db = new Database(path.join(cacheDir, "key", "index.sqlite"))
      try {
        expect(db.query("select path from file_runs order by path").all()).toEqual([{ path: "a.ts" }])
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("preserves worker failure when error-path flush fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let aEmbedded: (() => void) | undefined
      const aEmbeddedPromise = new Promise<void>((resolve) => {
        aEmbedded = resolve
      })
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as BatchResumableStore
      const originalGetCompletedFile = store.getCompletedFile.bind(store)
      store.getCompletedFile = async (runId, filePath, fingerprint) => {
        if (filePath === "b.ts") {
          await aEmbeddedPromise
          await new Promise((resolve) => setTimeout(resolve, 10))
          throw new Error("simulated worker failure")
        }
        return originalGetCompletedFile(runId, filePath, fingerprint)
      }
      store.writeFileResults = async () => {
        throw new Error("simulated flush failure")
      }
      store.writeFileResult = async () => {
        throw new Error("single file writes should not be called")
      }

      let thrown: unknown
      try {
        await createIndexer({
          worktree: dir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
          },
          store,
          parse: async () => ({ language: "typescript", root: undefined }),
          embed: async (text) => {
            if (text.includes("path: a.ts")) {
              aEmbedded?.()
            }
            return [1, 0]
          },
        }).refresh()
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(AggregateError)
      expect((thrown as AggregateError).errors).toHaveLength(2)
      expect((thrown as AggregateError).errors.map(String)).toEqual([
        "Error: simulated worker failure",
        "Error: simulated flush failure",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("falls back to single file-result writes when batch writes are unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      const originalWriteFileResult = store.writeFileResult.bind(store)
      disableBatchFileResultWrites(store)
      let singleWrites = 0
      store.writeFileResult = async (runId, fileResult) => {
        singleWrites++
        await originalWriteFileResult(runId, fileResult)
      }

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      }).refresh()

      expect(Object.keys(index.files)).toEqual(["a.ts"])
      expect(singleWrites).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("serializes legacy single file-result writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      const originalWriteFileResult = store.writeFileResult.bind(store)
      disableBatchFileResultWrites(store)
      let activeWrites = 0
      let overlapped = false
      store.writeFileResult = async (runId, fileResult) => {
        activeWrites++
        if (activeWrites > 1) {
          overlapped = true
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
        await originalWriteFileResult(runId, fileResult)
        activeWrites--
      }

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      }).refresh()

      expect(Object.keys(index.files).sort()).toEqual(["a.ts", "b.ts"])
      expect(overlapped).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("does not activate a replacement SQLite run when files are unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      const firstActiveRunId = readActiveRunId(cacheDir)
      await indexer.refresh()

      expect(readActiveRunId(cacheDir)).toBe(firstActiveRunId)
      expect(embedCalls).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reuses unchanged file from stat metadata before reading bytes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      await writeFile(filePath, "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      await chmod(filePath, 0)
      const unreadableStat = await stat(filePath)
      index.files["a.ts"].ctimeMs = unreadableStat.ctimeMs
      index.metadata.updatedAt = unreadableStat.ctimeMs + 2000
      const refreshed = await indexer.refresh()

      expect(refreshed.files["a.ts"]?.sizeBytes).toBeGreaterThan(0)
      expect(refreshed.files["a.ts"]?.mtimeMs).toBeTypeOf("number")
      expect(parseCalls).toBe(1)
      expect(embedCalls).toBe(1)
    } finally {
      await chmod(path.join(dir, "a.ts"), 0o600).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not parse or embed unchanged files after stat fast-path reuse", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const unchangedPath = path.join(dir, "unchanged.ts")
      const changedPath = path.join(dir, "changed.ts")
      await writeFile(unchangedPath, "export const unchanged = 1\n")
      await writeFile(changedPath, "export const changed = 1\n")
      const parsedFiles: string[] = []
      const embeddedTexts: string[] = []
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (filePath) => {
          parsedFiles.push(path.basename(filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()
      expect([...parsedFiles].sort()).toEqual(["changed.ts", "unchanged.ts"])
      expect(embeddedTexts).toHaveLength(2)
      parsedFiles.length = 0
      embeddedTexts.length = 0

      await chmod(unchangedPath, 0)
      const unreadableStat = await stat(unchangedPath)
      index.files["unchanged.ts"].ctimeMs = unreadableStat.ctimeMs
      index.metadata.updatedAt = unreadableStat.ctimeMs + 2000
      await writeFile(changedPath, "export const changed = 200\n")

      await indexer.refresh()

      expect(parsedFiles).toEqual(["changed.ts"])
      expect(embeddedTexts).toHaveLength(1)
      expect(embeddedTexts[0]).toContain("path: changed.ts")
      expect(embeddedTexts[0]).toContain("export const changed = 200")
    } finally {
      await chmod(path.join(dir, "unchanged.ts"), 0o600).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not reuse unreadable file when ctime differs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      await writeFile(filePath, "export const a = 1\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      const previousMtime = new Date(index.files["a.ts"].mtimeMs ?? 0)
      await writeFile(filePath, "export const b = 2\n")
      await utimes(filePath, previousMtime, previousMtime)
      await chmod(filePath, 0)
      const changedStat = await stat(filePath)
      index.files["a.ts"].sizeBytes = changedStat.size
      index.files["a.ts"].mtimeMs = changedStat.mtimeMs
      index.files["a.ts"].ctimeMs = changedStat.ctimeMs - 1

      await expect(indexer.refresh()).rejects.toThrow()
    } finally {
      await chmod(path.join(dir, "a.ts"), 0o600).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to fingerprint reuse when cached file stat metadata is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      await writeFile(filePath, "export const a = 1\n")
      const fingerprint = await testFingerprint(filePath)
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: DEFAULT_CHUNKING_OPTIONS,
      })
      index.metadata.status = "ready"
      index.metadata.maxFileBytes = DEFAULT_MAX_FILE_BYTES
      index.metadata.includeGlobs = ["**/*.ts"]
      index.metadata.excludeGlobs = []
      index.files["a.ts"] = { path: "a.ts", language: "typescript", fingerprint, chunkIds: ["a.ts:0"], diagnostics: [] }
      index.chunks["a.ts:0"] = {
        id: "a.ts:0",
        filePath: "a.ts",
        language: "typescript",
        kind: "file",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        text: "export const a = 1\n",
        nonWhitespaceChars: 15,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          throw new Error("old-cache unchanged file should be reused after fingerprinting")
        },
        embed: async () => {
          throw new Error("old-cache unchanged file should not be embedded")
        },
      })

      const refreshed = await indexer.refresh()

      expect(refreshed.files["a.ts"]?.sizeBytes).toBeUndefined()
      expect(refreshed.files["a.ts"]?.mtimeMs).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists ordered glob metadata changes on unchanged indexes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "src", "a.ts")
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, "export const a = 1\n")
      const fingerprint = await testFingerprint(filePath)
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: DEFAULT_CHUNKING_OPTIONS,
      })
      index.metadata.status = "ready"
      index.metadata.maxFileBytes = DEFAULT_MAX_FILE_BYTES
      index.metadata.includeGlobs = ["src/**/*.ts", "**/*.ts"]
      index.metadata.excludeGlobs = ["dist/**", "generated/**"]
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint,
        chunkIds: ["src/a.ts:0"],
        diagnostics: [],
      }
      index.chunks["src/a.ts:0"] = {
        id: "src/a.ts:0",
        filePath: "src/a.ts",
        language: "typescript",
        kind: "file",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        text: "export const a = 1\n",
        nonWhitespaceChars: 15,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts", "src/**/*.ts"],
          excludeGlobs: ["generated/**", "dist/**"],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          throw new Error("unchanged file should be reused")
        },
        embed: async () => {
          throw new Error("unchanged file should not be embedded")
        },
      })

      const refreshed = await indexer.refresh()

      expect(refreshed.metadata.includeGlobs).toEqual(["**/*.ts", "src/**/*.ts"])
      expect(refreshed.metadata.excludeGlobs).toEqual(["generated/**", "dist/**"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reuses file symbols through a per-file symbol index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function alpha() { return 1 }\n")
      await writeFile(path.join(dir, "b.ts"), "export function beta() { return 2 }\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const parseCalls: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (filePath, source) => {
          parseCalls.push(path.basename(filePath))
          return {
            language: "typescript",
            root: {
              type: "program",
              startIndex: 0,
              endIndex: source.length,
              children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
            },
          }
        },
        embed: async () => [1, 0, 0],
      })

      await indexer.refresh()
      const previousSymbols = index.symbols
      await indexer.refresh()

      expect(index.symbols).toEqual(previousSymbols)
      expect(parseCalls.sort()).toEqual(["a.ts", "b.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("updates a changed ready SQLite index with a replacement run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let beginRuns = 0
      let writes = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ReturnType<
        typeof createIndexStore
      > & {
        beginIndexRun(input: { configHash: string; metadata: CastIndex["metadata"] }): Promise<{ runId: string }>
      }
      const originalBeginIndexRun = store.beginIndexRun.bind(store)
      const originalWrite = store.write.bind(store)
      store.beginIndexRun = async (input) => {
        beginRuns++
        return originalBeginIndexRun(input)
      }
      store.write = async (index) => {
        writes++
        return originalWrite(index)
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      await writeFile(path.join(dir, "a.ts"), "export const a = 2\n")
      await indexer.refresh()

      expect(beginRuns).toBe(2)
      expect(writes).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("persists reused files into changed ready SQLite replacement runs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 1\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      await writeFile(path.join(dir, "a.ts"), "export const a = 2\n")
      const refreshed = await indexer.refresh()

      expect(Object.keys(refreshed.files).sort()).toEqual(["a.ts", "b.ts"])
      expect((await store.read()).metadata.status).toBe("ready")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("flushes queued reused file results when a changed file starts a run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await Promise.all(
        ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((fileName) =>
          writeFile(path.join(dir, fileName), `export const ${fileName[0]} = 1\n`),
        ),
      )
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as BatchResumableStore
      const originalWriteFileResults = store.writeFileResults.bind(store)
      const batchWrites: string[][] = []
      let firstRefreshComplete = false
      let batchWritesAtChangedParse: string[][] | undefined
      store.writeFileResults = async (runId, fileResults) => {
        batchWrites.push(fileResults.map((fileResult) => fileResult.file.path))
        await originalWriteFileResults(runId, fileResults)
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async (filePath) => {
          if (firstRefreshComplete && path.basename(filePath) === "e.ts") {
            batchWritesAtChangedParse = batchWrites.map((batch) => [...batch].sort())
          }
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      firstRefreshComplete = true
      batchWrites.length = 0
      await writeFile(path.join(dir, "e.ts"), "export const e = 2\n")

      await indexer.refresh()

      expect(batchWritesAtChangedParse).toEqual([["a.ts", "b.ts", "c.ts", "d.ts"]])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("flushes queued reused file results when an unchanged refresh reaches the reuse queue cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await Promise.all(
        Array.from({ length: 257 }, (_, index) => `${String(index).padStart(3, "0")}.ts`).map((fileName) =>
          writeFile(path.join(dir, fileName), `export const value${fileName.replace(/\W/g, "")} = 1\n`),
        ),
      )
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as BatchResumableStore
      const originalWriteFileResults = store.writeFileResults.bind(store)
      const batchWrites: number[] = []
      store.writeFileResults = async (runId, fileResults) => {
        batchWrites.push(fileResults.length)
        await originalWriteFileResults(runId, fileResults)
      }
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      batchWrites.length = 0
      await indexer.refresh()

      expect(batchWrites.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(256)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reused files omit unreferenced stale symbols", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      await writeFile(filePath, "export function used() { return 1 }\n")
      const fingerprint = await testFingerprint(filePath)
      const usedSymbol: SymbolRecord = {
        id: "a.ts:function:used",
        name: "used",
        kind: "function",
        filePath: "a.ts",
        range: { byteStart: 0, byteEnd: 35, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      const orphanSymbol: SymbolRecord = {
        id: "a.ts:function:orphan",
        name: "orphan",
        kind: "function",
        filePath: "a.ts",
        range: { byteStart: 0, byteEnd: 35, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      let index: CastIndex = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: DEFAULT_CHUNKING_OPTIONS,
      })
      index.metadata.status = "ready"
      index.metadata.maxFileBytes = DEFAULT_MAX_FILE_BYTES
      index.metadata.includeGlobs = ["**/*.ts"]
      index.metadata.excludeGlobs = []
      index.files["a.ts"] = { path: "a.ts", language: "typescript", fingerprint, chunkIds: ["a.ts:0"], diagnostics: [] }
      index.chunks["a.ts:0"] = {
        id: "a.ts:0",
        filePath: "a.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 35, lineStart: 1, lineEnd: 1 },
        text: "export function used() { return 1 }\n",
        nonWhitespaceChars: 28,
        nodeTypes: ["function_declaration"],
        symbolIds: [usedSymbol.id],
        childChunkIds: [],
        embedding: [1, 0],
      }
      index.symbols[usedSymbol.id] = usedSymbol
      index.symbols[orphanSymbol.id] = orphanSymbol
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          throw new Error("unchanged file should be reused")
        },
        embed: async () => {
          throw new Error("unchanged file should not be embedded")
        },
      })

      const refreshed = await indexer.refresh()

      expect(Object.keys(refreshed.symbols)).toEqual([usedSymbol.id])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reused files omit stale child symbols under a referenced parent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const filePath = path.join(dir, "a.ts")
      await writeFile(filePath, "export class Used { method() { return 1 } }\n")
      const fingerprint = await testFingerprint(filePath)
      const parentSymbol: SymbolRecord = {
        id: "a.ts:class:Used",
        name: "Used",
        kind: "class",
        filePath: "a.ts",
        range: { byteStart: 0, byteEnd: 41, lineStart: 1, lineEnd: 1 },
        childSymbolIds: ["a.ts:method:stale-child"],
      }
      const staleChildSymbol: SymbolRecord = {
        id: "a.ts:method:stale-child",
        name: "stale-child",
        kind: "method",
        filePath: "a.ts",
        range: { byteStart: 20, byteEnd: 40, lineStart: 1, lineEnd: 1 },
        parentSymbolId: parentSymbol.id,
        childSymbolIds: [],
      }
      let index: CastIndex = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: DEFAULT_CHUNKING_OPTIONS,
      })
      index.metadata.status = "ready"
      index.metadata.maxFileBytes = DEFAULT_MAX_FILE_BYTES
      index.metadata.includeGlobs = ["**/*.ts"]
      index.metadata.excludeGlobs = []
      index.files["a.ts"] = { path: "a.ts", language: "typescript", fingerprint, chunkIds: ["a.ts:0"], diagnostics: [] }
      index.chunks["a.ts:0"] = {
        id: "a.ts:0",
        filePath: "a.ts",
        language: "typescript",
        kind: "class",
        range: { byteStart: 0, byteEnd: 41, lineStart: 1, lineEnd: 1 },
        text: "export class Used { method() { return 1 } }\n",
        nonWhitespaceChars: 32,
        nodeTypes: ["class_declaration"],
        symbolIds: [parentSymbol.id],
        childChunkIds: [],
        embedding: [1, 0],
      }
      index.symbols[parentSymbol.id] = parentSymbol
      index.symbols[staleChildSymbol.id] = staleChildSymbol
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          throw new Error("unchanged file should be reused")
        },
        embed: async () => {
          throw new Error("unchanged file should not be embedded")
        },
      })

      const refreshed = await indexer.refresh()

      expect(Object.keys(refreshed.symbols)).toEqual([parentSymbol.id])
      expect(refreshed.symbols[parentSymbol.id]?.childSymbolIds).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not resume an in-progress run from a different worktree", async () => {
    const firstDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-a-"))
    const secondDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-b-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(firstDir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(secondDir, "a.ts"), "export const a = 1\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      disableBatchFileResultWrites(store)
      const originalWriteFileResult = store.writeFileResult.bind(store)
      let firstWrite = true
      store.writeFileResult = async (runId, fileResult) => {
        await originalWriteFileResult(runId, fileResult)
        if (firstWrite) {
          firstWrite = false
          throw new Error("simulated crash after file write")
        }
      }
      await expect(
        createIndexer({
          worktree: firstDir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
          },
          store,
          parse: async () => ({ language: "typescript", root: undefined }),
          embed: async () => [1, 0],
        }).refresh(),
      ).rejects.toThrow("simulated crash after file write")

      let secondParseCalls = 0
      await createIndexer({
        worktree: secondDir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => {
          secondParseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      }).refresh()

      expect(secondParseCalls).toBe(1)
    } finally {
      await rm(firstDir, { recursive: true, force: true })
      await rm(secondDir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reprocesses a resumed completed file with embedding errors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      disableBatchFileResultWrites(store)
      const originalWriteFileResult = store.writeFileResult.bind(store)
      let fileWrites = 0
      store.writeFileResult = async (runId, fileResult) => {
        fileWrites++
        if (fileWrites === 1) {
          await originalWriteFileResult(runId, {
            ...fileResult,
            chunks: Object.fromEntries(
              Object.entries(fileResult.chunks).map(([id, chunk]) => [
                id,
                { ...chunk, embedding: undefined, embeddingError: "temporary embed failure" },
              ]),
            ),
          })
          throw new Error("simulated crash after degraded file")
        }
        await originalWriteFileResult(runId, fileResult)
      }
      const options = {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: [],
      }
      const makeIndexer = () =>
        createIndexer({
          worktree: dir,
          options,
          store,
          parse: async () => {
            parseCalls++
            return { language: "typescript", root: undefined }
          },
          embed: async () => {
            embedCalls++
            return [1, 0]
          },
        })

      await expect(makeIndexer().refresh()).rejects.toThrow("simulated crash after degraded file")
      const index = await makeIndexer().refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(Object.values(index.chunks)[0].embedding).toEqual([1, 0])
      expect(Object.values(index.chunks)[0].embeddingError).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reprocesses a resumed completed file when chunk text cannot be reconstructed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      const sourcePath = path.join(dir, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      disableBatchFileResultWrites(store)
      const originalWriteFileResult = store.writeFileResult.bind(store)
      let fileWrites = 0
      store.writeFileResult = async (runId, fileResult) => {
        await originalWriteFileResult(runId, fileResult)
        fileWrites++
        if (fileWrites === 1) {
          throw new Error("simulated crash after completed file")
        }
      }
      const options = {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: [],
      }
      const makeIndexer = () =>
        createIndexer({
          worktree: dir,
          options,
          store,
          parse: async () => {
            parseCalls++
            return { language: "typescript", root: undefined }
          },
          embed: async () => {
            embedCalls++
            return [1, 0]
          },
        })

      await expect(makeIndexer().refresh()).rejects.toThrow("simulated crash after completed file")
      store.writeFileResult = originalWriteFileResult
      const db = new Database(path.join(cacheDir, "key", "index.sqlite"))
      try {
        const run = db.query("select id, metadata_json as metadataJson from runs where status = 'indexing'").get() as {
          id: string
          metadataJson: string
        }
        const metadata = JSON.parse(run.metadataJson)
        db.run("update runs set metadata_json = ? where id = ?", [
          JSON.stringify({ ...metadata, worktree: path.join(dir, "missing") }),
          run.id,
        ])
      } finally {
        db.close()
      }

      const index = await makeIndexer().refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(Object.values(index.chunks)[0].text).toBe("export const a = 1\n")
      expect(
        (await createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }).read()).metadata.status,
      ).toBe("ready")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("keeps an old active SQLite run readable when a ready refresh write fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "old.ts"), "export const old = true\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }) as ResumableStore
      const oldIndex = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
      })
      oldIndex.metadata.status = "ready"
      oldIndex.metadata.embeddingDimensions = 2
      oldIndex.files["old.ts"] = {
        path: "old.ts",
        language: "typescript",
        fingerprint: "old",
        chunkIds: ["old"],
        diagnostics: [],
      }
      oldIndex.chunks.old = {
        id: "old",
        filePath: "old.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
        text: "function old() {}",
        nonWhitespaceChars: 10,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      await store.write(oldIndex)
      await writeFile(path.join(dir, "old.ts"), "export const old = false\n")
      store.activateRun = async () => {
        throw new Error("simulated ready refresh activation failure")
      }

      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [0, 1],
      })

      await expect(indexer.refresh()).rejects.toThrow("simulated ready refresh activation failure")
      const cached = await createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 }).read()

      expect(Object.keys(cached.files)).toEqual(["old.ts"])
      expect(cached.files["old.ts"].fingerprint).toBe("old")
      expect((cached as CastIndex).chunks.old.embedding).toEqual([1, 0])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("indexes changed files and removes deleted files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      const writes: unknown[] = []
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
      })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
            writes.push(next)
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      expect(Object.keys(index.files)).toEqual(["a.ts"])
      expect(Object.values(index.chunks)).toHaveLength(1)

      await rm(path.join(dir, "a.ts"))
      await indexer.refresh()
      expect(Object.keys(index.files)).toEqual([])
      expect(Object.values(index.chunks)).toHaveLength(0)
      expect(writes.length).toBeGreaterThanOrEqual(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips symlinked files instead of indexing their target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-outside-"))
    try {
      await writeFile(path.join(outside, "secret.ts"), "export const secret = 'outside'\n")
      await symlink(path.join(outside, "secret.ts"), path.join(dir, "secret.ts"))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()

      expect(index.files["secret.ts"]).toBeUndefined()
      expect(embeddedTexts).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("skips files ignored by gitignore", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, ".gitignore"), "ignored.ts\nnested/\n")
      await writeFile(path.join(dir, "kept.ts"), "export const kept = true\n")
      await writeFile(path.join(dir, "ignored.ts"), "export const ignored = true\n")
      await mkdir(path.join(dir, "nested"))
      await writeFile(path.join(dir, "nested", "ignored.ts"), "export const nestedIgnored = true\n")
      await mkdir(path.join(dir, "subdir"))
      await writeFile(path.join(dir, "subdir", ".gitignore"), "local-ignored.ts\n")
      await writeFile(path.join(dir, "subdir", "kept.ts"), "export const nestedKept = true\n")
      await writeFile(path.join(dir, "subdir", "local-ignored.ts"), "export const localIgnored = true\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files).sort()).toEqual(["kept.ts", "subdir/kept.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("matches dotfiles and dot directories with scanner globs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, ".hidden.ts"), "export const hidden = true\n")
      await mkdir(path.join(dir, ".config"))
      await writeFile(path.join(dir, ".config", "tool.ts"), "export const tool = true\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files).sort()).toEqual([".config/tool.ts", ".hidden.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not traverse directories excluded by scanner globs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const excludedDir = path.join(dir, "excluded")
    try {
      await writeFile(path.join(dir, "kept.ts"), "export const kept = true\n")
      await mkdir(excludedDir)
      await writeFile(path.join(excludedDir, "hidden.ts"), "export const hidden = true\n")
      await chmod(excludedDir, 0)
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: ["excluded/**"],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files)).toEqual(["kept.ts"])
    } finally {
      await chmod(excludedDir, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("indexes deep files without traversing excluded subtrees", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const deepPathSegments = Array.from({ length: 40 }, (_, index) => `level-${index}`)
      const current = path.join(dir, ...deepPathSegments)
      await mkdir(current, { recursive: true })
      await writeFile(path.join(current, "deep.ts"), "export const deepValue = 1\n")
      await mkdir(path.join(dir, "ignored", "nested"), { recursive: true })
      await writeFile(path.join(dir, "ignored", "nested", "skip.ts"), "export const skipped = 1\n")

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: ["ignored/**"],
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0, 0],
      }).refresh()

      expect(Object.keys(index.files)).toEqual([`${deepPathSegments.join("/")}/deep.ts`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("scan predicates preserve include and exclude glob semantics", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await mkdir(path.join(dir, "src"), { recursive: true })
      await mkdir(path.join(dir, "vendor"), { recursive: true })
      await writeFile(path.join(dir, "src", "keep.ts"), "export const keep = 1\n")
      await writeFile(path.join(dir, "src", "drop.map"), "{}\n")
      await writeFile(path.join(dir, "vendor", "skip.ts"), "export const skip = 1\n")

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["src/**"],
          excludeGlobs: ["**/*.map", "vendor/**"],
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0, 0],
      }).refresh()

      expect(Object.keys(index.files)).toEqual(["src/keep.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("single-level exclude globs do not prune deeper descendants", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await mkdir(path.join(dir, "foo", "bar"), { recursive: true })
      await writeFile(path.join(dir, "foo", "drop.ts"), "export const drop = 1\n")
      await writeFile(path.join(dir, "foo", "bar", "keep.ts"), "export const keep = 1\n")

      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["foo/**/*.ts"],
          excludeGlobs: ["foo/*"],
        },
        store: createMemoryStore(),
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0, 0],
      }).refresh()

      expect(Object.keys(index.files)).toEqual(["foo/bar/keep.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("starts indexing yielded files before traversal finishes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const unreadableDir = path.join(dir, "z-unreadable")
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await mkdir(unreadableDir)
      await chmod(unreadableDir, 0)
      const parsedPaths: string[] = []

      await expect(
        createIndexer({
          worktree: dir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
          },
          store: createMemoryStore(),
          parse: async (filePath) => {
            parsedPaths.push(path.relative(dir, filePath))
            return { language: "typescript", root: undefined }
          },
          embed: async () => [1, 0, 0],
        }).refresh(),
      ).rejects.toThrow()

      expect(parsedPaths).toEqual(["a.ts"])
    } finally {
      await chmod(unreadableDir, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips default language artifact directories without traversing them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const pycacheDir = path.join(dir, "__pycache__")
    try {
      await writeFile(path.join(dir, "kept.py"), "def kept():\n    return True\n")
      await mkdir(pycacheDir)
      await writeFile(path.join(pycacheDir, "kept.cpython-312.pyc"), new Uint8Array([1, 2, 3]))
      await chmod(pycacheDir, 0)
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const options = parseOptions({})
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
          includeGlobs: options.includeGlobs,
          excludeGlobs: options.excludeGlobs,
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "python", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files)).toEqual(["kept.py"])
    } finally {
      await chmod(pycacheDir, 0o700).catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips binary files and reports a diagnostic", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "source.ts"), "export const source = true\n")
      await writeFile(path.join(dir, "image.bin"), new Uint8Array([0, 159, 146, 150]))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const parsedPaths: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          maxFileBytes: 1024,
          includeGlobs: ["**/*"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (filePath) => {
          parsedPaths.push(path.basename(filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files)).toEqual(["source.ts"])
      expect(parsedPaths).toEqual(["source.ts"])
      expect(index.metadata.diagnostics).toContain("image.bin: skipped binary file")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips files over maxFileBytes and reports a diagnostic", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "source.ts"), "export const source = true\n")
      await writeFile(path.join(dir, "large.txt"), "x".repeat(200))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const parsedPaths: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          maxFileBytes: 100,
          includeGlobs: ["**/*"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (filePath) => {
          parsedPaths.push(path.basename(filePath))
          return { language: "typescript", root: undefined }
        },
        embed: async () => [1, 0],
      })

      await indexer.refresh()

      expect(Object.keys(index.files)).toEqual(["source.ts"])
      expect(parsedPaths).toEqual(["source.ts"])
      expect(index.metadata.diagnostics).toContain("large.txt: skipped file over maxFileBytes (200 > 100)")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("syncs scanner-owned metadata before writing a missing store index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key" })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 17,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      const index = await store.read()

      expect(index.metadata.worktree).toBe(dir)
      expect(index.metadata.maxChunkNonWhitespaceChars).toBe(17)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("preserves unchanged file chunks and symbols without parsing or embedding again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, source) => {
          parseCalls++
          return {
            language: "typescript",
            root: {
              type: "program",
              startIndex: 0,
              endIndex: source.length,
              children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
            },
          }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      const previousFiles = index.files
      const previousChunks = index.chunks
      const previousSymbols = index.symbols

      await indexer.refresh()

      expect(parseCalls).toBe(1)
      expect(embedCalls).toBe(1)
      expect(index.files).toEqual(previousFiles)
      expect(index.chunks).toEqual(previousChunks)
      expect(index.symbols).toEqual(previousSymbols)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists refreshed scanner metadata when file contents are unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const makeIndexer = (maxFileBytes: number) =>
        createIndexer({
          worktree: dir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            maxFileBytes,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
          },
          store,
          parse: async () => ({ language: "typescript", root: undefined }),
          embed: async () => [1, 0],
        })

      await makeIndexer(123).refresh()
      await makeIndexer(456).refresh()
      const metadata = await store.readMetadata()

      expect(metadata.maxFileBytes).toBe(456)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reprocesses an active index file when reused chunk text is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const options = {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: [],
      }
      const makeIndexer = () =>
        createIndexer({
          worktree: dir,
          options,
          store,
          parse: async () => {
            parseCalls++
            return { language: "typescript", root: undefined }
          },
          embed: async () => {
            embedCalls++
            return [1, 0]
          },
        })

      await makeIndexer().refresh()
      const db = new Database(path.join(cacheDir, "key", "index.sqlite"))
      try {
        const activeRun = db.query("select value from meta where key = 'active_run_id'").get() as { value: string }
        const run = db.query("select metadata_json as metadataJson from runs where id = ?").get(activeRun.value) as {
          metadataJson: string
        }
        const metadata = JSON.parse(run.metadataJson)
        db.run("update runs set metadata_json = ? where id = ?", [
          JSON.stringify({ ...metadata, worktree: path.join(dir, "missing") }),
          activeRun.value,
        ])
      } finally {
        db.close()
      }
      const hydrated = await store.read()

      expect(Object.values(hydrated.chunks)[0].text).toBe("")
      expect(hydrated.metadata.diagnostics).toContain("source read failed for a.ts; chunk text unavailable")

      const index = await makeIndexer().refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(Object.values(index.chunks)[0].text).toBe("export const a = 1\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("reindexes unchanged files when chunking options change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 },
      })
      const makeIndexer = (chunking: { overlap: number; expansion: boolean; minSemanticNonWhitespaceChars: number }) =>
        createIndexer({
          worktree: dir,
          options: {
            maxChunkNonWhitespaceChars: 2000,
            includeGlobs: ["**/*.ts"],
            excludeGlobs: [],
            chunking,
          },
          store: {
            read: async () => index,
            write: async (next) => {
              index = next
            },
          },
          parse: async (_filePath, source) => {
            parseCalls++
            return {
              language: "typescript",
              root: {
                type: "program",
                startIndex: 0,
                endIndex: source.length,
                children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
              },
            }
          },
          embed: async () => {
            embedCalls++
            return [1, 0]
          },
        })

      await makeIndexer({ overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 8 }).refresh()
      await makeIndexer({ overlap: 1, expansion: false, minSemanticNonWhitespaceChars: 8 }).refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(index.metadata.chunking).toEqual({ overlap: 1, expansion: false, minSemanticNonWhitespaceChars: 8 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("detects same-size content edits even when mtime is unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const file = path.join(dir, "a.ts")
      const fixedTime = new Date(1_700_000_000_000)
      await writeFile(file, "export const a = 1\n")
      await utimes(file, fixedTime, fixedTime)
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      await writeFile(file, "export const b = 2\n")
      await utimes(file, fixedTime, fixedTime)
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records that reference missing chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      delete index.chunks[index.files["a.ts"].chunkIds[0]]
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(index.files["a.ts"].chunkIds.every((id) => index.chunks[id])).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records with dangling chunk topology references", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      Object.values(index.chunks)[0].childChunkIds = ["missing"]
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(
        Object.values(index.chunks)
          .flatMap((chunk) => chunk.childChunkIds)
          .every((id) => index.chunks[id]),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged files with topology references to pruned files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      index.chunks[index.files["a.ts"].chunkIds[0]].childChunkIds = [index.files["b.ts"].chunkIds[0]]
      await rm(path.join(dir, "b.ts"))
      await indexer.refresh()

      expect(parseCalls).toBe(3)
      expect(embedCalls).toBe(3)
      expect(Object.keys(index.files)).toEqual(["a.ts"])
      expect(
        Object.values(index.chunks)
          .flatMap((chunk) => chunk.childChunkIds)
          .every((id) => index.chunks[id]),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds reused files with references to included files that are rebuilt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      await writeFile(path.join(dir, "b.ts"), "export const b = 2\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      index.chunks[index.files["a.ts"].chunkIds[0]].childChunkIds = [index.files["b.ts"].chunkIds[0]]
      await writeFile(path.join(dir, "b.ts"), "export const b = 3\n")
      await indexer.refresh()

      expect(parseCalls).toBe(4)
      expect(embedCalls).toBe(4)
      expect(
        Object.values(index.chunks)
          .flatMap((chunk) => chunk.childChunkIds)
          .every((id) => index.chunks[id]),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records with mismatched file or chunk paths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      index.files["a.ts"].path = "deleted.ts"
      index.chunks[index.files["a.ts"].chunkIds[0]].filePath = "deleted.ts"
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(index.files["a.ts"].path).toBe("a.ts")
      expect(
        Object.values(index.chunks).every(
          (chunk) => chunk.filePath === "a.ts" && chunk.language === index.files["a.ts"].language,
        ),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records with mismatched chunk map keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      index.chunks[index.files["a.ts"].chunkIds[0]].id = "different"
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(index.files["a.ts"].chunkIds.every((id) => index.chunks[id]?.id === id)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records with mismatched symbol map keys", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, source) => {
          parseCalls++
          return {
            language: "typescript",
            root: {
              type: "program",
              startIndex: 0,
              endIndex: source.length,
              children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
            },
          }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      index.symbols[Object.values(index.chunks)[0].symbolIds[0]].id = "different"
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(
        Object.values(index.chunks)
          .flatMap((chunk) => chunk.symbolIds)
          .every((id) => index.symbols[id]?.id === id),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("embeds path language symbol breadcrumbs and chunk text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      const embeddedTexts: string[] = []
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, source) => ({
          language: "typescript",
          root: {
            type: "program",
            startIndex: 0,
            endIndex: source.length,
            children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
          },
        }),
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()

      expect(embeddedTexts[0]).toContain("path: a.ts")
      expect(embeddedTexts[0]).toContain("language: typescript")
      expect(embeddedTexts[0]).toContain("symbols:\nfunction a")
      expect(embeddedTexts[0]).toContain("text:\nexport function a() { return 1 }")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("adds expansion metadata to embedding input without changing stored chunk text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const source = "export function findWidget() { return 1 }\n"
      await writeFile(path.join(dir, "nested.ts"), source)
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: { overlap: 0, expansion: true, minSemanticNonWhitespaceChars: 8 },
      })
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          chunking: { overlap: 0, expansion: true, minSemanticNonWhitespaceChars: 8 },
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, text) => ({
          language: "typescript",
          root: {
            type: "program",
            startIndex: 0,
            endIndex: text.length,
            children: [{ type: "function_declaration", startIndex: 0, endIndex: text.length, children: [] }],
          },
        }),
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()

      const chunk = Object.values(index.chunks)[0]
      expect(chunk.text).toBe(source)
      expect(embeddedTexts[0]).toContain("chunk:\nkind: file")
      expect(embeddedTexts[0]).toContain("range: 1-1")
      expect(embeddedTexts[0]).toContain("text:\nexport function findWidget() { return 1 }")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports multiline trailing-newline ranges in expansion metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      const source = "const a = 1\nconst b = 2\n"
      await writeFile(path.join(dir, "multi.ts"), source)
      let index = createEmptyIndex({
        projectId: "p",
        worktree: dir,
        cacheKey: "key",
        maxChunkNonWhitespaceChars: 2000,
        chunking: { overlap: 0, expansion: true, minSemanticNonWhitespaceChars: 8 },
      })
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          chunking: { overlap: 0, expansion: true, minSemanticNonWhitespaceChars: 8 },
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, text) => ({
          language: "typescript",
          root: { type: "program", startIndex: 0, endIndex: text.length, children: [] },
        }),
        embed: async (text) => {
          embeddedTexts.push(text)
          return [1, 0]
        },
      })

      await indexer.refresh()

      expect(Object.values(index.chunks)[0].range.lineEnd).toBe(2)
      expect(embeddedTexts[0]).toContain("range: 1-2")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("retries unchanged chunks with embedding errors and clears the stale error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => {
          parseCalls++
          return { language: "typescript", root: undefined }
        },
        embed: async () => {
          embedCalls++
          if (embedCalls === 1) {
            throw new Error("temporary embed failure")
          }
          return [1, 0]
        },
      })

      await indexer.refresh()
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(Object.values(index.chunks)).toHaveLength(1)
      expect(Object.values(index.chunks)[0].embedding).toEqual([1, 0])
      expect(Object.values(index.chunks)[0].embeddingError).toBeUndefined()
      expect(index.files["a.ts"].diagnostics).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rebuilds unchanged file records with dangling chunk symbol references", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, source) => {
          parseCalls++
          return {
            language: "typescript",
            root: {
              type: "program",
              startIndex: 0,
              endIndex: source.length,
              children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
            },
          }
        },
        embed: async () => {
          embedCalls++
          return [1, 0]
        },
      })

      await indexer.refresh()
      delete index.symbols[Object.values(index.chunks)[0].symbolIds[0]]
      await indexer.refresh()

      expect(parseCalls).toBe(2)
      expect(embedCalls).toBe(2)
      expect(
        Object.values(index.chunks)
          .flatMap((chunk) => chunk.symbolIds)
          .every((id) => index.symbols[id]),
      ).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records embedding failures on chunks and still writes the index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      let writes = 0
      let embedCalls = 0
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
            writes++
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => {
          embedCalls++
          if (embedCalls === 1) {
            throw new Error("embed failed")
          }
          return [1, 0]
        },
      })

      await indexer.refresh()

      expect(writes).toBe(1)
      expect(index.metadata.status).toBe("ready")
      expect(index.files["a.ts"]?.diagnostics).toEqual(["embedding failed: embed failed"])
      expect(Object.values(index.chunks).some((chunk) => chunk.embeddingError === "embed failed")).toBe(true)
      expect(Object.values(index.chunks).some((chunk) => chunk.embedding?.join(",") === "1,0")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("embeds changed chunks in configured batches and flushes partial batches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "abcde\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const batches: string[][] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          embeddingBatchSize: 3,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 1 },
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => {
          throw new Error("single embedding should not be used")
        },
        embedBatch: async (texts) => {
          batches.push(texts)
          return texts.map((_, batchIndex) => [batches.length, batchIndex])
        },
      })

      await indexer.refresh()

      expect(batches.map((batch) => batch.length)).toEqual([3, 2])
      expect(Object.values(index.chunks).map((chunk) => chunk.embedding)).toEqual([
        [1, 0],
        [1, 1],
        [1, 2],
        [2, 0],
        [2, 1],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uses configured concurrency for embedding batches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.txt"), "abcdef\n")
      let active = 0
      let maxActive = 0
      const store = createMemoryStore(
        createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 }),
      )
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.txt"],
          excludeGlobs: [],
          embeddingBatchSize: 1,
          embeddingBatchConcurrency: 2,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 1 },
        },
        store,
        parse: async () => ({ language: "text", root: undefined }),
        embed: async () => {
          throw new Error("single embedding should not be used")
        },
        embedBatch: async (texts) => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active--
          return texts.map((_, index) => [active, index])
        },
      })

      await indexer.refresh()

      expect(maxActive).toBeGreaterThan(1)
      expect(maxActive).toBeLessThanOrEqual(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records synchronous batch embedding failures without hanging workers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          embeddingBatchSize: 2,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 1 },
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => {
          throw new Error("single embedding should not be used")
        },
        embedBatch: () => {
          throw new Error("batch embed failed synchronously")
        },
      })

      const result = await Promise.race([
        indexer.refresh().then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ])

      expect(result).toBe("settled")
      expect(Object.values(index.chunks).map((chunk) => chunk.embeddingError)).toEqual([
        "batch embed failed synchronously",
        "batch embed failed synchronously",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("records synchronous single embedding failures without hanging workers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          embeddingBatchSize: 2,
          chunking: { overlap: 0, expansion: false, minSemanticNonWhitespaceChars: 1 },
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: () => {
          throw new Error("single embed failed synchronously")
        },
      })

      const result = await Promise.race([
        indexer.refresh().then(() => "settled" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ])

      expect(result).toBe("settled")
      expect(Object.values(index.chunks).map((chunk) => chunk.embeddingError)).toEqual([
        "single embed failed synchronously",
        "single embed failed synchronously",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists lexical stats from chunk text and code metadata despite embedding failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await writeFile(path.join(dir, "nested.ts"), "export function findWidget() { return 1 }\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
        },
        store: {
          read: async () => index,
          write: async (next) => {
            index = next
          },
        },
        parse: async (_filePath, source) => ({
          language: "typescript",
          root: {
            type: "program",
            startIndex: 0,
            endIndex: source.length,
            children: [{ type: "function_declaration", startIndex: 0, endIndex: source.length, children: [] }],
          },
        }),
        embed: async () => {
          throw new Error("embed failed")
        },
      })

      await indexer.refresh()

      const chunk = Object.values(index.chunks)[0]
      expect(index.lexical?.documentCount).toBe(1)
      expect(index.lexical?.averageDocumentLength).toBe(chunk.lexical?.length)
      expect(chunk.embeddingError).toBe("embed failed")
      expect(chunk.lexical?.termFrequencies.findwidget).toBeGreaterThan(0)
      expect(chunk.lexical?.termFrequencies.nested).toBeGreaterThan(0)
      expect(chunk.lexical?.termFrequencies.ts).toBeGreaterThan(0)
      expect(chunk.lexical?.termFrequencies.file).toBeGreaterThan(0)
      expect(chunk.lexical?.termFrequencies.program).toBeGreaterThan(0)
      expect(chunk.lexical?.termFrequencies.function).toBeGreaterThan(0)
      expect(index.lexical?.documentFrequencies.findwidget).toBe(1)
      expect(index.lexical?.documentFrequencies.nested).toBe(1)
      expect(index.lexical?.documentFrequencies.ts).toBe(1)
      expect(index.lexical?.documentFrequencies.file).toBe(1)
      expect(index.lexical?.documentFrequencies.program).toBe(1)
      expect(index.lexical?.documentFrequencies.function).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
