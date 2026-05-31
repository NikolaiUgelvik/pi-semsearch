import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
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
  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer())
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(bytes)
  return hash.digest("hex")
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

function disableBatchFileResultWrites(store: ResumableStore) {
  const storeWithoutBatch = store as Partial<BatchResumableStore>
  storeWithoutBatch.writeFileResults = undefined
}

describe("createIndexer", () => {
  test("batches embeddings across files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
      const batches: string[][] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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

  test("limits in-flight embedding batches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await Bun.write(
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
          topK: 5,
          maxContextChars: 12_000,
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

  test("processes independent files concurrently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a-slow.ts"), "export const slow = 1\n")
      await Bun.write(path.join(dir, "b-fail.ts"), "export const fail = 2\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(filePath, fileText)
      let parseSource = ""
      const index = await createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
        topK: 5,
        maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
            topK: 5,
            maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
            topK: 5,
            maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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

  test("updates a changed ready SQLite index with a replacement run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
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
          topK: 5,
          maxContextChars: 12_000,
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      await Bun.write(path.join(dir, "a.ts"), "export const a = 2\n")
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 1\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
        },
        store,
        parse: async () => ({ language: "typescript", root: undefined }),
        embed: async () => [1, 0],
      })

      await indexer.refresh()
      await Bun.write(path.join(dir, "a.ts"), "export const a = 2\n")
      const refreshed = await indexer.refresh()

      expect(Object.keys(refreshed.files).sort()).toEqual(["a.ts", "b.ts"])
      expect((await store.read()).metadata.status).toBe("ready")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  test("does not resume an in-progress run from a different worktree", async () => {
    const firstDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-a-"))
    const secondDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-b-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await Bun.write(path.join(firstDir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(secondDir, "a.ts"), "export const a = 1\n")
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
            topK: 5,
            maxContextChars: 12_000,
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
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
        topK: 5,
        maxContextChars: 12_000,
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
      await Bun.write(sourcePath, "export const a = 1\n")
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
        topK: 5,
        maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "old.ts"), "export const old = true\n")
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
      await Bun.write(path.join(dir, "old.ts"), "export const old = false\n")
      store.activateRun = async () => {
        throw new Error("simulated ready refresh activation failure")
      }

      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(outside, "secret.ts"), "export const secret = 'outside'\n")
      await symlink(path.join(outside, "secret.ts"), path.join(dir, "secret.ts"))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const embeddedTexts: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, ".gitignore"), "ignored.ts\nnested/\n")
      await Bun.write(path.join(dir, "kept.ts"), "export const kept = true\n")
      await Bun.write(path.join(dir, "ignored.ts"), "export const ignored = true\n")
      await mkdir(path.join(dir, "nested"))
      await Bun.write(path.join(dir, "nested", "ignored.ts"), "export const nestedIgnored = true\n")
      await mkdir(path.join(dir, "subdir"))
      await Bun.write(path.join(dir, "subdir", ".gitignore"), "local-ignored.ts\n")
      await Bun.write(path.join(dir, "subdir", "kept.ts"), "export const nestedKept = true\n")
      await Bun.write(path.join(dir, "subdir", "local-ignored.ts"), "export const localIgnored = true\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, ".hidden.ts"), "export const hidden = true\n")
      await mkdir(path.join(dir, ".config"))
      await Bun.write(path.join(dir, ".config", "tool.ts"), "export const tool = true\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "kept.ts"), "export const kept = true\n")
      await mkdir(excludedDir)
      await Bun.write(path.join(excludedDir, "hidden.ts"), "export const hidden = true\n")
      await chmod(excludedDir, 0)
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: ["excluded/**"],
          topK: 5,
          maxContextChars: 12_000,
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

  test("skips default language artifact directories without traversing them", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const pycacheDir = path.join(dir, "__pycache__")
    try {
      await Bun.write(path.join(dir, "kept.py"), "def kept():\n    return True\n")
      await mkdir(pycacheDir)
      await Bun.write(path.join(pycacheDir, "kept.cpython-312.pyc"), new Uint8Array([1, 2, 3]))
      await chmod(pycacheDir, 0)
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const options = parseOptions({})
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
          includeGlobs: options.includeGlobs,
          excludeGlobs: options.excludeGlobs,
          topK: options.topK,
          maxContextChars: options.maxContextChars,
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
      await Bun.write(path.join(dir, "source.ts"), "export const source = true\n")
      await Bun.write(path.join(dir, "image.bin"), new Uint8Array([0, 159, 146, 150]))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const parsedPaths: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          maxFileBytes: 1024,
          includeGlobs: ["**/*"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "source.ts"), "export const source = true\n")
      await Bun.write(path.join(dir, "large.txt"), "x".repeat(200))
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const parsedPaths: string[] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          maxFileBytes: 100,
          includeGlobs: ["**/*"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      const store = createIndexStore({ cacheDir, cacheKey: "key" })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 17,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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

  test("reprocesses an active index file when reused chunk text is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-cache-"))
    try {
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      const store = createIndexStore({ cacheDir, cacheKey: "key", embeddingDimensions: 2 })
      const options = {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: [],
        topK: 5,
        maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
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
            topK: 5,
            maxContextChars: 12_000,
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
      await Bun.write(file, "export const a = 1\n")
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(file, "export const b = 2\n")
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "b.ts"), "export const b = 3\n")
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      const embeddedTexts: string[] = []
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "nested.ts"), source)
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "multi.ts"), source)
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
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "export function a() { return 1 }\n")
      let parseCalls = 0
      let embedCalls = 0
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      let writes = 0
      let embedCalls = 0
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "abcde\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const batches: string[][] = []
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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

  test("records synchronous batch embedding failures without hanging workers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
    try {
      await Bun.write(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "a.ts"), "ab\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 1 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 1,
          maxFileBytes: 1024,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
      await Bun.write(path.join(dir, "nested.ts"), "export function findWidget() { return 1 }\n")
      let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
      const indexer = createIndexer({
        worktree: dir,
        options: {
          maxChunkNonWhitespaceChars: 2000,
          includeGlobs: ["**/*.ts"],
          excludeGlobs: [],
          topK: 5,
          maxContextChars: 12_000,
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
