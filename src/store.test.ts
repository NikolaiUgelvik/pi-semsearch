import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { load as loadSqliteVec } from "sqlite-vec"
import { cosineSimilarity, createEmptyIndex, createIndexStore, searchVectors } from "./store.js"
import type { CastIndex, ChunkRecord, FileRecord, LexicalChunkCandidate, SymbolRecord } from "./types.js"

type VectorSearchStore = ReturnType<typeof createIndexStore> & {
  searchVectorCandidates?: (
    queryEmbedding: number[],
    topK: number,
    paths?: string[],
  ) => Promise<Array<{ id: string; score: number }>>
}

type LexicalSearchStore = ReturnType<typeof createIndexStore> & {
  searchLexicalCandidates?(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>
}

type ResumableStore = ReturnType<typeof createIndexStore> & {
  beginIndexRun(input: { configHash: string; metadata: CastIndex["metadata"] }): Promise<{ runId: string }>
  getCompletedFile(
    runId: string,
    path: string,
    fingerprint: string,
  ): Promise<
    | {
        file: FileRecord
        chunks: Record<string, ChunkRecord>
        symbols: Record<string, SymbolRecord>
      }
    | undefined
  >
  writeFileResult(
    runId: string,
    fileResult: { file: FileRecord; chunks: Record<string, ChunkRecord>; symbols: Record<string, SymbolRecord> },
  ): Promise<void>
  activateRun(runId: string, index: CastIndex): Promise<void>
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

const MISSING_CHUNK_RECORD_COLUMN_PATTERN = /record_json|no such column/

function chunk(id: string, filePath: string, embedding: number[]): ChunkRecord {
  return {
    id,
    filePath,
    language: "typescript",
    kind: "function",
    range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
    text: `function ${id}() {}`,
    nonWhitespaceChars: 10,
    nodeTypes: [],
    symbolIds: [],
    childChunkIds: [],
    embedding,
  }
}

async function testFingerprint(filePath: string) {
  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer())
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(bytes)
  return hash.digest("hex")
}

describe("index store", () => {
  test("does not persist chunk source text in SQLite record JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      await mkdir(worktree, { recursive: true })
      const sourcePath = path.join(worktree, "src.ts")
      await Bun.write(sourcePath, "function hello() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["hello"],
        diagnostics: [],
      }
      index.chunks.hello = {
        id: "hello",
        filePath: "src.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        text: "function hello() {}",
        nonWhitespaceChars: 17,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      await store.write(index)

      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        const row = db.query("select record_json as recordJson from chunks").get() as { recordJson: string }
        const record = JSON.parse(row.recordJson) as Record<string, unknown>

        expect(row.recordJson).not.toContain("function hello")
        expect(Object.hasOwn(record, "text")).toBe(false)
        expect(Object.hasOwn(record, "embedding")).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists optional file stat metadata in SQLite records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function hello() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        sizeBytes: 20,
        mtimeMs: 1234,
        chunkIds: ["hello"],
        diagnostics: [],
      }
      index.chunks.hello = chunk("hello", "src.ts", [1, 0])

      await store.write(index)
      const cached = await store.read()

      expect(cached.files["src.ts"]?.sizeBytes).toBe(20)
      expect(cached.files["src.ts"]?.mtimeMs).toBe(1234)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns empty chunk text and diagnostic when source fingerprint mismatches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function hello() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["hello"],
        diagnostics: [],
      }
      index.chunks.hello = {
        id: "hello",
        filePath: "src.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        text: "function hello() {}",
        nonWhitespaceChars: 17,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      await store.write(index)
      await Bun.write(sourcePath, "function changed() {}\n")

      const cached = await store.read()

      expect(cached.chunks.hello.text).toBe("")
      expect(cached.metadata.diagnostics).toContain("source fingerprint mismatch for src.ts; chunk text unavailable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns empty chunk text and diagnostic when source read failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function hello() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["hello"],
        diagnostics: [],
      }
      index.chunks.hello = {
        id: "hello",
        filePath: "src.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        text: "function hello() {}",
        nonWhitespaceChars: 17,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      await store.write(index)
      await rm(sourcePath)

      const cached = await store.read()

      expect(cached.chunks.hello.text).toBe("")
      expect(cached.metadata.diagnostics).toContain("source read failed for src.ts; chunk text unavailable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns empty chunk text and diagnostic when source range invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function hello() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["hello"],
        diagnostics: [],
      }
      index.chunks.hello = {
        id: "hello",
        filePath: "src.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 200, lineStart: 1, lineEnd: 1 },
        text: "function hello() {}",
        nonWhitespaceChars: 17,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0],
      }
      await store.write(index)

      const cached = await store.read()

      expect(cached.chunks.hello.text).toBe("")
      expect(cached.metadata.diagnostics).toContain("source range invalid for src.ts:hello; chunk text unavailable")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("resumes the latest indexing run with the same config hash", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2

      const first = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      const resumed = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      const different = await store.beginIndexRun({ configHash: "different", metadata: index.metadata })

      expect(resumed.runId).toBe(first.runId)
      expect(different.runId).not.toBe(first.runId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps the previous active SQLite run readable until a new run is activated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const oldIndex = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
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
      oldIndex.chunks.old = chunk("old", "old.ts", [1, 0])
      await store.write(oldIndex)

      const metadata = { ...oldIndex.metadata, status: "indexing" as const, updatedAt: Date.now() }
      const { runId } = await store.beginIndexRun({ configHash: "refresh", metadata })
      await store.writeFileResult(runId, {
        file: { path: "old.ts", language: "typescript", fingerprint: "new", chunkIds: ["new"], diagnostics: [] },
        chunks: { new: chunk("new", "old.ts", [0, 1]) },
        symbols: {},
      })

      const cached = await store.read()

      expect(Object.keys(cached.files)).toEqual(["old.ts"])
      expect(cached.files["old.ts"].fingerprint).toBe("old")
      expect(cached.chunks.old?.embedding).toEqual([1, 0])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not let in-progress global file metadata change a legacy active run read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const oldIndex = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      oldIndex.metadata.status = "ready"
      oldIndex.metadata.embeddingDimensions = 2
      oldIndex.files["old.ts"] = {
        path: "old.ts",
        language: "typescript",
        fingerprint: "old",
        chunkIds: ["old"],
        diagnostics: ["old diagnostic"],
      }
      oldIndex.chunks.old = chunk("old", "old.ts", [1, 0])
      await store.write(oldIndex)
      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        db.run("update file_runs set language = null, fingerprint = null, diagnostics_json = null")
      } finally {
        db.close()
      }

      const metadata = { ...oldIndex.metadata, status: "indexing" as const, updatedAt: Date.now() }
      const { runId } = await store.beginIndexRun({ configHash: "refresh", metadata })
      await store.writeFileResult(runId, {
        file: { path: "old.ts", language: "typescript", fingerprint: "new", chunkIds: ["new"], diagnostics: [] },
        chunks: { new: chunk("new", "old.ts", [0, 1]) },
        symbols: {},
      })

      const cached = await store.read()

      expect(cached.files["old.ts"]).toEqual(oldIndex.files["old.ts"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("prunes superseded SQLite runs after activating a replacement run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const oldIndex = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
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
      oldIndex.chunks.old = chunk("old", "old.ts", [1, 0])
      await store.write(oldIndex)

      const newIndex = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      newIndex.metadata.status = "ready"
      newIndex.metadata.embeddingDimensions = 2
      newIndex.files["new.ts"] = {
        path: "new.ts",
        language: "typescript",
        fingerprint: "new",
        chunkIds: ["new"],
        diagnostics: [],
      }
      newIndex.chunks.new = chunk("new", "new.ts", [0, 1])
      const { runId } = await store.beginIndexRun({
        configHash: "same-config",
        metadata: { ...newIndex.metadata, status: "indexing" },
      })
      await store.writeFileResult(runId, {
        file: newIndex.files["new.ts"],
        chunks: { new: newIndex.chunks.new },
        symbols: {},
      })

      await store.activateRun(runId, newIndex)

      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        loadSqliteVec(db)
        expect(db.query("select count(*) as count from runs").get()).toEqual({ count: 1 })
        expect(db.query("select count(*) as count from chunks").get()).toEqual({ count: 1 })
        expect(db.query("select count(*) as count from chunk_rowids").get()).toEqual({ count: 1 })
        expect(db.query("select count(*) as count from chunk_vectors").get()).toEqual({ count: 1 })
        expect(db.query("select id from chunks").get()).toEqual({ id: "new" })
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("activates an indexing run without rewriting existing file and chunk rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      const symbol: SymbolRecord = {
        id: "sym-a",
        name: "a",
        kind: "function",
        filePath: "src/a.ts",
        range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: "fresh",
        chunkIds: ["a"],
        diagnostics: [],
      }
      index.chunks.a = { ...chunk("a", "src/a.ts", [1, 0]), symbolIds: [symbol.id] }
      index.symbols[symbol.id] = symbol
      const { runId } = await store.beginIndexRun({
        configHash: "same-config",
        metadata: { ...index.metadata, status: "indexing" },
      })
      await store.writeFileResult(runId, {
        file: index.files["src/a.ts"],
        chunks: { a: index.chunks.a },
        symbols: { [symbol.id]: symbol },
      })
      index.chunks.a.lexical = { length: 2, termFrequencies: { alpha: 1, function: 1 } }
      index.lexical = {
        documentCount: 1,
        averageDocumentLength: 2,
        documentFrequencies: { alpha: 1, function: 1 },
      }
      const dbPath = path.join(dir, "project", "index.sqlite")
      const db = new Database(dbPath)
      let expectedVectorRow: { vectorRowid: number; embeddingJson: string }
      try {
        loadSqliteVec(db)
        const chunkRow = db
          .query("select record_json as recordJson from chunks where run_id = ? and id = ?")
          .get(runId, "a") as {
          recordJson: string
        }
        db.run("update chunks set record_json = ? where run_id = ? and id = ?", [
          JSON.stringify({ ...JSON.parse(chunkRow.recordJson), activationMarker: true }),
          runId,
          "a",
        ])
        const symbolRow = db
          .query("select record_json as recordJson from symbols where run_id = ? and id = ?")
          .get(runId, symbol.id) as {
          recordJson: string
        }
        db.run("update symbols set record_json = ? where run_id = ? and id = ?", [
          JSON.stringify({ ...JSON.parse(symbolRow.recordJson), activationMarker: true }),
          runId,
          symbol.id,
        ])
        db.run("update file_runs set diagnostics_json = ? where run_id = ? and path = ?", [
          JSON.stringify(["activation-marker"]),
          runId,
          "src/a.ts",
        ])
        expectedVectorRow = db
          .query(
            `select chunk_rowids.rowid as vectorRowid,
                    vec_to_json(chunk_vectors.embedding) as embeddingJson
             from chunk_rowids
             inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
             where chunk_rowids.run_id = ? and chunk_rowids.chunk_id = ?`,
          )
          .get(runId, "a") as { vectorRowid: number; embeddingJson: string }
      } finally {
        db.close()
      }

      await store.activateRun(runId, index)

      const reopened = new Database(dbPath)
      try {
        loadSqliteVec(reopened)
        const row = reopened
          .query(
            `select chunks.record_json as chunkJson,
                    file_runs.diagnostics_json as diagnosticsJson,
                    symbols.record_json as symbolJson,
                    chunk_rowids.rowid as vectorRowid,
                    vec_to_json(chunk_vectors.embedding) as embeddingJson
             from chunks
             inner join file_runs on file_runs.run_id = chunks.run_id and file_runs.path = chunks.file_path
             inner join symbols on symbols.run_id = chunks.run_id and symbols.id = ?
             inner join chunk_rowids on chunk_rowids.run_id = chunks.run_id and chunk_rowids.chunk_id = chunks.id
             inner join chunk_vectors on chunk_vectors.rowid = chunk_rowids.rowid
             where chunks.run_id = ? and chunks.id = ?`,
          )
          .get(symbol.id, runId, "a") as {
          chunkJson: string
          diagnosticsJson: string
          symbolJson: string
          vectorRowid: number
          embeddingJson: string
        }
        expect(JSON.parse(row.chunkJson).activationMarker).toBe(true)
        expect(JSON.parse(row.chunkJson).lexical).toEqual(index.chunks.a.lexical)
        expect(JSON.parse(row.diagnosticsJson)).toEqual(["activation-marker"])
        expect(JSON.parse(row.symbolJson).activationMarker).toBe(true)
        expect(row.vectorRowid).toBe(expectedVectorRow.vectorRowid)
        expect(row.embeddingJson).toBe(expectedVectorRow.embeddingJson)
      } finally {
        reopened.close()
      }
      expect((await store.read()).chunks.a.lexical).toEqual(index.chunks.a.lexical)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not activate an incomplete indexing run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: "fresh",
        chunkIds: ["a"],
        diagnostics: [],
      }
      index.chunks.a = chunk("a", "src/a.ts", [1, 0])
      const { runId } = await store.beginIndexRun({
        configHash: "same-config",
        metadata: { ...index.metadata, status: "indexing" },
      })

      await expect(store.activateRun(runId, index)).rejects.toThrow("incomplete indexing run")
      expect((await store.read()).metadata.status).toBe("empty")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrates a completed file from an indexing run by matching fingerprint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "function a() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      const file = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["a"],
        diagnostics: [],
      }
      await store.writeFileResult(runId, { file, chunks: { a: chunk("a", "src/a.ts", [1, 0]) }, symbols: {} })

      const completed = await store.getCompletedFile(runId, "src/a.ts", file.fingerprint)
      const stale = await store.getCompletedFile(runId, "src/a.ts", "changed")

      expect(completed?.file).toEqual(file)
      expect(completed?.chunks.a.embedding).toEqual([1, 0])
      expect(stale).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes multiple completed file results in one indexing run batch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const aPath = path.join(worktree, "src/a.ts")
      const bPath = path.join(worktree, "src/b.ts")
      await mkdir(path.dirname(aPath), { recursive: true })
      await Bun.write(aPath, "function a() {}\n")
      await Bun.write(bPath, "function b() {}\n")
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as BatchResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      const aFile = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: await testFingerprint(aPath),
        chunkIds: ["a"],
        diagnostics: [],
      }
      const bFile = {
        path: "src/b.ts",
        language: "typescript",
        fingerprint: await testFingerprint(bPath),
        chunkIds: ["b"],
        diagnostics: [],
      }

      await store.writeFileResults(runId, [
        { file: aFile, chunks: { a: chunk("a", "src/a.ts", [1, 0]) }, symbols: {} },
        { file: bFile, chunks: { b: chunk("b", "src/b.ts", [0, 1]) }, symbols: {} },
      ])

      const completedA = await store.getCompletedFile(runId, "src/a.ts", aFile.fingerprint)
      const completedB = await store.getCompletedFile(runId, "src/b.ts", bFile.fingerprint)

      expect(completedA?.file).toEqual(aFile)
      expect(completedA?.chunks.a.embedding).toEqual([1, 0])
      expect(completedB?.file).toEqual(bFile)
      expect(completedB?.chunks.b.embedding).toEqual([0, 1])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrates completed file chunk text from the run worktree source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "const before = 1\nfunction alpha() {}\n")
      const sourceText = "function alpha() {}"
      const byteStart = "const before = 1\n".length
      const byteEnd = byteStart + sourceText.length
      const fingerprint = await testFingerprint(sourcePath)
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      const file = { path: "src/a.ts", language: "typescript", fingerprint, chunkIds: ["alpha"], diagnostics: [] }
      await store.writeFileResult(runId, {
        file,
        chunks: {
          alpha: {
            id: "alpha",
            filePath: "src/a.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart, byteEnd, lineStart: 2, lineEnd: 2 },
            text: sourceText,
            nonWhitespaceChars: 17,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [1, 0],
          },
        },
        symbols: {},
      })

      const completed = await store.getCompletedFile(runId, "src/a.ts", fingerprint)

      expect(completed?.chunks.alpha.text).toBe(sourceText)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrates completed file without reading unrelated chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const firstPath = path.join(worktree, "src/a.ts")
      const secondPath = path.join(worktree, "src/b.ts")
      await mkdir(path.dirname(firstPath), { recursive: true })
      await Bun.write(firstPath, "function alpha() {}\n")
      await Bun.write(secondPath, "function beta() {}\n")
      const firstFingerprint = await testFingerprint(firstPath)
      const secondFingerprint = await testFingerprint(secondPath)
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      await store.writeFileResult(runId, {
        file: {
          path: "src/a.ts",
          language: "typescript",
          fingerprint: firstFingerprint,
          chunkIds: ["alpha"],
          diagnostics: [],
        },
        chunks: {
          alpha: {
            id: "alpha",
            filePath: "src/a.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
            text: "function alpha() {}",
            nonWhitespaceChars: 17,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [1, 0],
          },
        },
        symbols: {},
      })
      await store.writeFileResult(runId, {
        file: {
          path: "src/b.ts",
          language: "typescript",
          fingerprint: secondFingerprint,
          chunkIds: ["beta"],
          diagnostics: [],
        },
        chunks: {
          beta: {
            id: "beta",
            filePath: "src/b.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart: 0, byteEnd: 18, lineStart: 1, lineEnd: 1 },
            text: "function beta() {}",
            nonWhitespaceChars: 16,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [0, 1],
          },
        },
        symbols: {},
      })
      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        db.run("update chunks set record_json = ? where run_id = ? and id = ?", ["{", runId, "beta"])
      } finally {
        db.close()
      }

      const completed = await store.getCompletedFile(runId, "src/a.ts", firstFingerprint)

      expect(completed?.chunks.alpha.text).toBe("function alpha() {}")
      expect(completed?.chunks.alpha.embedding).toEqual([1, 0])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not return completed file when source fingerprint mismatches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\n")
      const fingerprint = await testFingerprint(sourcePath)
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      await store.writeFileResult(runId, {
        file: { path: "src/a.ts", language: "typescript", fingerprint, chunkIds: ["alpha"], diagnostics: [] },
        chunks: {
          alpha: {
            id: "alpha",
            filePath: "src/a.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
            text: "function alpha() {}",
            nonWhitespaceChars: 17,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [1, 0],
          },
        },
        symbols: {},
      })
      await Bun.write(sourcePath, "function changed() {}\n")

      const completed = await store.getCompletedFile(runId, "src/a.ts", fingerprint)

      expect(completed).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not return completed file when source read failed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\n")
      const fingerprint = await testFingerprint(sourcePath)
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      await store.writeFileResult(runId, {
        file: { path: "src/a.ts", language: "typescript", fingerprint, chunkIds: ["alpha"], diagnostics: [] },
        chunks: {
          alpha: {
            id: "alpha",
            filePath: "src/a.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
            text: "function alpha() {}",
            nonWhitespaceChars: 17,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [1, 0],
          },
        },
        symbols: {},
      })
      await rm(sourcePath)

      const completed = await store.getCompletedFile(runId, "src/a.ts", fingerprint)

      expect(completed).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("does not return completed file when source range is invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\n")
      const fingerprint = await testFingerprint(sourcePath)
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 }) as ResumableStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "indexing"
      index.metadata.embeddingDimensions = 2
      const { runId } = await store.beginIndexRun({ configHash: "same", metadata: index.metadata })
      await store.writeFileResult(runId, {
        file: { path: "src/a.ts", language: "typescript", fingerprint, chunkIds: ["alpha"], diagnostics: [] },
        chunks: {
          alpha: {
            id: "alpha",
            filePath: "src/a.ts",
            language: "typescript",
            kind: "function",
            range: { byteStart: 0, byteEnd: 200, lineStart: 1, lineEnd: 1 },
            text: "function alpha() {}",
            nonWhitespaceChars: 17,
            nodeTypes: [],
            symbolIds: [],
            childChunkIds: [],
            embedding: [1, 0],
          },
        },
        symbols: {},
      })

      const completed = await store.getCompletedFile(runId, "src/a.ts", fingerprint)

      expect(completed).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("searches vectors with sqlite-vec", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.near = {
        id: "near",
        filePath: "src/near.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
        text: "function near() {}",
        nonWhitespaceChars: 16,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [1, 0, 0, 0],
      }
      index.chunks.far = {
        id: "far",
        filePath: "test/far.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
        text: "function far() {}",
        nonWhitespaceChars: 15,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        embedding: [0, 1, 0, 0],
      }
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 2)

      expect(results?.map((result) => result.id)).toEqual(["near", "far"])
      expect(results?.every((result) => Number.isFinite(result.score))).toBe(true)
      expect(results?.[0].score).toBeGreaterThanOrEqual(results?.[1].score ?? Number.POSITIVE_INFINITY)
      expect(await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 2, ["test/"])).toEqual([
        { id: "far", score: results?.[1].score },
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("sqlite vector candidates do not use the full vector JSON scan path", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8")

    expect(source).toContain("embedding match ?")
    expect(source).not.toContain("readSqliteVectorRows")
    expect(source).not.toContain("scoreSqliteVectorRows")
  })

  test("sqlite vector candidate query keeps vec KNN isolated from normal table joins", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8")

    expect(source).toContain("rowid in (select rowid from chunk_rowids where run_id = ?)")
    expect(source).toContain("embedding match ? and k = ?")
    expect(source).not.toContain("from chunk_vectors\n       inner join chunk_rowids")
  })

  test("active vector count does not join the sqlite-vec virtual table", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8")

    expect(source).toContain("select count(*) as count\n       from chunk_rowids\n       where run_id = ?")
    expect(source).not.toContain("select count(*) as count\n       from chunk_rowids\n       inner join chunk_vectors")
  })

  test("path-filtered sqlite vector expansion stays within sqlite-vec k limits", async () => {
    const source = await readFile(new URL("./store.ts", import.meta.url), "utf8")

    expect(source).toContain("const SQLITE_VECTOR_MAX_K = 4096")
    expect(source).toContain("Math.min(vectorCount, SQLITE_VECTOR_MAX_K")
    expect(source).not.toContain("const SQLITE_VECTOR_PATH_FILTER_MAX_K = 10_000")
  })

  test("returns cosine scores for orthogonal sqlite-vec candidates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.orthogonal = chunk("orthogonal", "src/orthogonal.ts", [0, 1, 0, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 1)

      expect(results?.[0]).toEqual({ id: "orthogonal", score: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns cosine-best sqlite vector even when distance-best differs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.distanceBest = chunk("distanceBest", "src/distance-best.ts", [0.9, 0.1])
      index.chunks.cosineBest = chunk("cosineBest", "src/cosine-best.ts", [100, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0], 1)

      expect(results).toEqual([{ id: "cosineBest", score: 1 }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns no sqlite vector candidates for query dimension mismatch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.match = chunk("match", "src/match.ts", [1, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0], 1)

      expect(results).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns no sqlite vector candidates for malformed sparse query vectors", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.match = chunk("match", "src/match.ts", [1, 0])
      await store.write(index)
      const sparseQuery = new Array<number>(2)
      sparseQuery[0] = 1

      const results = await (store as VectorSearchStore).searchVectorCandidates?.(sparseQuery, 1)

      expect(results).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("searches path-filtered sqlite vectors after applying path filters", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.outside = chunk("outside", "vendor/outside.ts", [1, 0, 0, 0])
      index.chunks.inside = chunk("inside", "src/inside.ts", [0.5, 0.5, 0, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 1, ["src/"])

      expect(results?.map((result) => result.id)).toEqual(["inside"])
      expect(results?.[0].score).toBeCloseTo(cosineSimilarity([1, 0, 0, 0], [0.5, 0.5, 0, 0]))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("preserves mixed path filter OR semantics for sqlite vector candidates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.src = chunk("src", "src/a.ts", [1, 0, 0, 0])
      index.chunks.test = chunk("test", "test/b.ts", [0.8, 0.2, 0, 0])
      index.chunks.other = chunk("other", "lib/c.ts", [0.9, 0.1, 0, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 2, [
        "src/*.ts",
        "test/",
      ])

      expect(results?.map((result) => result.id)).toEqual(["src", "test"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("matches bracket globs for sqlite vector path filters", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.a = chunk("a", "src/a.ts", [1, 0, 0, 0])
      index.chunks.b = chunk("b", "src/b.ts", [0.9, 0.1, 0, 0])
      index.chunks.c = chunk("c", "src/c.ts", [0.8, 0.2, 0, 0])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0, 0, 0], 3, ["src/[ab].ts"])

      expect(results?.map((result) => result.id)).toEqual(["a", "b"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("marks path-filtered sqlite vector results incomplete when the max search window is exhausted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      for (let indexNumber = 0; indexNumber < 4096; indexNumber += 1) {
        index.chunks[`outside-${indexNumber}`] = chunk(`outside-${indexNumber}`, `vendor/${indexNumber}.ts`, [1, 0])
      }
      index.chunks.allowed = chunk("allowed", "src/allowed.ts", [0, 1])
      await store.write(index)

      const results = await (store as VectorSearchStore).searchVectorCandidates?.([1, 0], 2, ["**/allowed.ts"])

      expect(results).toEqual([])
      expect((results as typeof results & { incomplete?: boolean })?.incomplete).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("populates SQLite FTS rows when writing an index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: "a",
        chunkIds: ["alpha"],
        diagnostics: [],
      }
      index.chunks.alpha = { ...chunk("alpha", "src/a.ts", [1, 0]), text: "uniqueftscontent alpha body" }

      await store.write(index)

      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        const row = db.query("select id, content from chunk_fts where chunk_fts match ?").get("uniqueftscontent") as {
          id: string
          content: string
        } | null

        expect(row).toEqual({ id: "alpha", content: "uniqueftscontent alpha body" })
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("searches lexical candidates with SQLite FTS5", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.alpha = { ...chunk("alpha", "src/a.ts", [1, 0]), text: "needleterm only here" }
      index.chunks.beta = { ...chunk("beta", "src/b.ts", [0, 1]), text: "ordinary code" }
      await store.write(index)

      const results = await store.searchLexicalCandidates?.("needleterm", 5)

      expect(results).toHaveLength(1)
      expect(results?.[0].id).toBe("alpha")
      expect(results?.[0].score).toBe(results?.[0].bm25Score)
      expect(results?.[0].bm25Score).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("orders lexical candidates by SQLite FTS5 rank and returns higher-is-better BM25 scores", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.strong = { ...chunk("strong", "src/strong.ts", [1, 0]), text: "rankterm rankterm rankterm" }
      index.chunks.weak = { ...chunk("weak", "src/weak.ts", [0, 1]), text: "rankterm other words in a longer body" }
      await store.write(index)

      const results = await store.searchLexicalCandidates?.("rankterm", 2)
      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        const ftsRows = db
          .query("select id, rank from chunk_fts where chunk_fts match ? order by rank limit ?")
          .all("rankterm", 2) as Array<{ id: string; rank: number }>

        expect(results?.map((result) => result.id)).toEqual(ftsRows.map((row) => row.id))
        expect(results?.every((result) => result.score === result.bm25Score)).toBe(true)
        expect(results?.map((result) => result.bm25Score)).toEqual(ftsRows.map((row) => row.rank * -1))
        expect(results?.every((result) => result.score > 0)).toBe(true)
        expect(results?.[0].bm25Score).toBeGreaterThanOrEqual(results?.[1].bm25Score ?? 0)
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("applies path filters to SQLite FTS5 lexical candidates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.outside = { ...chunk("outside", "vendor/outside.ts", [1, 0]), text: "filterterm filterterm" }
      index.chunks.inside = { ...chunk("inside", "src/inside.ts", [0, 1]), text: "filterterm" }
      await store.write(index)

      const results = await store.searchLexicalCandidates?.("filterterm", 5, ["src/"])

      expect(results?.map((result) => result.id)).toEqual(["inside"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("applies minimatch brace path filters to SQLite FTS5 lexical candidates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.a = { ...chunk("a", "src/a.ts", [1, 0]), text: "braceterm" }
      index.chunks.b = { ...chunk("b", "src/b.ts", [0, 1]), text: "braceterm" }
      index.chunks.c = { ...chunk("c", "src/c.ts", [0.5, 0.5]), text: "braceterm" }
      await store.write(index)

      const results = await store.searchLexicalCandidates?.("braceterm", 5, ["src/{a,b}.ts"])

      expect(results?.map((result) => result.id).sort()).toEqual(["a", "b"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("applies minimatch extglob path filters to SQLite FTS5 lexical candidates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.a = { ...chunk("a", "src/a.ts", [1, 0]), text: "extglobterm" }
      index.chunks.b = { ...chunk("b", "src/b.ts", [0, 1]), text: "extglobterm" }
      index.chunks.c = { ...chunk("c", "src/c.ts", [0.5, 0.5]), text: "extglobterm" }
      await store.write(index)

      const results = await store.searchLexicalCandidates?.("extglobterm", 5, ["src/@(a|b).ts"])

      expect(results?.map((result) => result.id).sort()).toEqual(["a", "b"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to tokenized lexical search for malformed FTS5 queries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({
        cacheDir: dir,
        cacheKey: "project",
        embeddingDimensions: 2,
      }) as LexicalSearchStore
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.chunks.alpha = { ...chunk("alpha", "src/a.ts", [1, 0]), text: "class Foo { method() {} }" }
      await store.write(index)

      const results = await Promise.all(
        ["foo:", "foo -bar", "class Foo {", '"foo'].map((query) => store.searchLexicalCandidates?.(query, 3)),
      )

      expect(results.map((result) => result?.map((candidate) => candidate.id))).toEqual([
        ["alpha"],
        ["alpha"],
        ["alpha"],
        ["alpha"],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates a SQLite index database instead of index.json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })

      const index = await store.read()

      expect(index.metadata.status).toBe("empty")
      expect(index.files).toEqual({})
      expect(index.chunks).toEqual({})
      expect(index.symbols).toEqual({})
      expect(await Bun.file(path.join(dir, "project", "index.sqlite")).exists()).toBe(true)
      expect(await Bun.file(path.join(dir, "project", "index.json")).exists()).toBe(false)
      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        expect(db.query("select value from meta where key = 'schema_version'").get()).toEqual({ value: "4" })
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("ignores old index.json caches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const oldIndex = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      oldIndex.metadata.status = "ready"
      oldIndex.files["old.ts"] = {
        path: "old.ts",
        language: "typescript",
        fingerprint: "old",
        chunkIds: ["old"],
        diagnostics: [],
      }
      oldIndex.chunks.old = chunk("old", "old.ts", [1, 0, 0, 0])
      await mkdir(path.join(dir, "project"), { recursive: true })
      await Bun.write(path.join(dir, "project", "index.json"), JSON.stringify(oldIndex))

      const cached = await createIndexStore({ cacheDir: dir, cacheKey: "project" }).read()

      expect(cached.metadata.status).toBe("empty")
      expect(cached.files).toEqual({})
      expect(cached.chunks).toEqual({})
      expect(await Bun.file(path.join(dir, "project", "index.sqlite")).exists()).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists and hydrates the active run index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src/a.ts")
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await Bun.write(sourcePath, "\nfunction alpha() {}\n")
      const index: CastIndex = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.updatedAt = 1234
      index.metadata.embeddingModel = "test-model"
      index.metadata.embeddingDimensions = 4
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["chunk-1"],
        diagnostics: ["file diagnostic"],
      }
      index.chunks["chunk-1"] = {
        id: "chunk-1",
        filePath: "src/a.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 1, byteEnd: 20, lineStart: 2, lineEnd: 4 },
        text: "function alpha() {}",
        nonWhitespaceChars: 17,
        nodeTypes: ["function_declaration"],
        symbolIds: ["symbol-1"],
        childChunkIds: [],
        embedding: [0.1, 0.2, 0.3, 0.4],
        lexical: { length: 3, termFrequencies: { alpha: 1, function: 1 } },
      }
      index.symbols["symbol-1"] = {
        id: "symbol-1",
        name: "alpha",
        kind: "function",
        filePath: "src/a.ts",
        range: { byteStart: 1, byteEnd: 20, lineStart: 2, lineEnd: 4 },
        childSymbolIds: [],
      }
      index.lexical = {
        documentCount: 1,
        averageDocumentLength: 3,
        documentFrequencies: { alpha: 1, function: 1 },
      }

      await createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 }).write(index)
      const cached = await createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 }).read()

      expect(cached.metadata.status).toBe("ready")
      expect(cached.metadata.updatedAt).toBe(1234)
      expect(cached.metadata.embeddingModel).toBe("test-model")
      expect(cached.metadata.embeddingDimensions).toBe(4)
      expect(cached.files["src/a.ts"]).toEqual(index.files["src/a.ts"])
      expect(cached.chunks["chunk-1"]).toEqual(index.chunks["chunk-1"])
      expect(cached.symbols["symbol-1"]).toEqual(index.symbols["symbol-1"])
      expect(cached.lexical).toEqual(index.lexical)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("readMetadata reads active metadata without hydrating full chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      await mkdir(worktree, { recursive: true })
      const sourcePath = path.join(worktree, "src.ts")
      await Bun.write(sourcePath, "function alpha() {}\nfunction beta() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.updatedAt = 1234
      index.metadata.embeddingModel = "test-model"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["alpha", "beta"],
        diagnostics: [],
      }
      index.chunks.alpha = chunk("alpha", "src.ts", [1, 0])
      index.chunks.beta = chunk("beta", "src.ts", [0, 1])
      await store.write(index)

      const metadata = await store.readMetadata()

      expect(metadata.status).toBe("ready")
      expect(metadata.cacheKey).toBe("project")
      expect(metadata.worktree).toBe(worktree)
      expect(metadata.updatedAt).toBe(1234)
      expect(metadata.embeddingModel).toBe("test-model")
      expect(metadata.embeddingDimensions).toBe(2)
      expect(Object.hasOwn(metadata as object, "chunks")).toBe(false)
      expect(Object.hasOwn(metadata as object, "files")).toBe(false)
      expect(Object.hasOwn(metadata as object, "symbols")).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("readMetadata returns empty metadata without an active run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })

      const metadata = await store.readMetadata()

      expect(metadata.status).toBe("empty")
      expect(metadata.cacheKey).toBe("project")
      expect(metadata.embeddingDimensions).toBe(2)
      expect(metadata.diagnostics).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("creates indexes for file-path scoped store operations", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      await store.readMetadata()

      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        const indexNames = db
          .query("select name from sqlite_master where type = 'index' and name not like 'sqlite_autoindex_%'")
          .all() as Array<{ name: string }>

        expect(indexNames.map((row) => row.name).sort()).toContain("chunks_run_file_path_idx")
        expect(indexNames.map((row) => row.name).sort()).toContain("symbols_run_file_path_idx")
        expect(indexNames.map((row) => row.name).sort()).toContain("chunk_rowids_run_rowid_idx")
      } finally {
        db.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrateChunks returns selected chunks as a HydratedChunkSet without global lexical metadata by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const alphaPath = path.join(worktree, "src/a.ts")
      const betaPath = path.join(worktree, "src/b.ts")
      await mkdir(path.dirname(alphaPath), { recursive: true })
      await Bun.write(alphaPath, "function alpha() {}\n")
      await Bun.write(betaPath, "function beta() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src/a.ts"] = {
        path: "src/a.ts",
        language: "typescript",
        fingerprint: await testFingerprint(alphaPath),
        chunkIds: ["alpha"],
        diagnostics: [],
      }
      index.files["src/b.ts"] = {
        path: "src/b.ts",
        language: "typescript",
        fingerprint: await testFingerprint(betaPath),
        chunkIds: ["beta"],
        diagnostics: [],
      }
      index.chunks.alpha = {
        ...chunk("alpha", "src/a.ts", [1, 0]),
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        symbolIds: ["symbol-alpha"],
      }
      index.chunks.beta = {
        ...chunk("beta", "src/b.ts", [0, 1]),
        range: { byteStart: 0, byteEnd: 18, lineStart: 1, lineEnd: 1 },
        symbolIds: ["symbol-beta"],
        lexical: { length: 2, termFrequencies: { beta: 1, function: 1 } },
      }
      index.symbols["symbol-alpha"] = {
        id: "symbol-alpha",
        name: "alpha",
        kind: "function",
        filePath: "src/a.ts",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      index.symbols["symbol-beta"] = {
        id: "symbol-beta",
        name: "beta",
        kind: "function",
        filePath: "src/b.ts",
        range: { byteStart: 0, byteEnd: 18, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      index.lexical = {
        documentCount: 2,
        averageDocumentLength: 2,
        documentFrequencies: { function: 2 },
      }
      await store.write(index)

      const hydrated = await store.hydrateChunks(["beta"])

      expect(hydrated.metadata.status).toBe("ready")
      expect(hydrated.metadata.cacheKey).toBe("project")
      expect(Object.keys(hydrated.chunks)).toEqual(["beta"])
      expect(hydrated.chunks.beta.text).toBe("function beta() {}")
      expect(hydrated.chunks.beta.lexical).toEqual(index.chunks.beta.lexical)
      expect(Object.keys(hydrated.files)).toEqual(["src/b.ts"])
      expect(Object.keys(hydrated.symbols)).toEqual(["symbol-beta"])
      expect(hydrated.lexical).toBeUndefined()
      expect(hydrated.diagnostics).toEqual([])
      expect(Object.keys(hydrated).sort()).toEqual(["chunks", "diagnostics", "files", "metadata", "symbols"])

      const hydratedWithLexical = await store.hydrateChunks(["beta"], { includeLexical: true })
      expect(hydratedWithLexical.lexical).toEqual(index.lexical)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrates selected chunks and topology context by id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "a.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(
        sourcePath,
        "function before() {}\nfunction parent() {\n  function child() {}\n}\nfunction after() {}\n",
      )
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["a.ts"] = {
        path: "a.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["before", "parent", "child", "after"],
        diagnostics: [],
      }
      index.chunks.before = {
        ...chunk("before", "a.ts", [0.8, 0.2]),
        range: { byteStart: 0, byteEnd: 20, lineStart: 1, lineEnd: 1 },
        nextSiblingChunkId: "parent",
      }
      index.chunks.parent = {
        ...chunk("parent", "a.ts", [1, 0]),
        range: { byteStart: 21, byteEnd: 64, lineStart: 2, lineEnd: 4 },
        childChunkIds: ["child"],
        previousSiblingChunkId: "before",
        nextSiblingChunkId: "after",
      }
      index.chunks.child = {
        ...chunk("child", "a.ts", [0.9, 0.1]),
        range: { byteStart: 43, byteEnd: 62, lineStart: 3, lineEnd: 3 },
        parentChunkId: "parent",
        childChunkIds: [],
      }
      index.chunks.after = {
        ...chunk("after", "a.ts", [0.7, 0.3]),
        range: { byteStart: 65, byteEnd: 84, lineStart: 5, lineEnd: 5 },
        previousSiblingChunkId: "parent",
      }
      await store.write(index)

      const hydrated = await store.hydrateChunks(["parent"])

      expect(Object.keys(hydrated.chunks)).toEqual(["parent", "child", "before", "after"])
      expect(hydrated.chunks.parent.text).toContain("function parent")
      expect(hydrated.chunks.child.text).toBe("function child() {}")
      expect(hydrated.chunks.before.text).toBe("function before() {}")
      expect(hydrated.chunks.after.text).toBe("function after() {}")
      expect(hydrated.files["a.ts"].chunkIds).toEqual(["before", "parent", "child", "after"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrateChunks preserves requested order and ignores missing ids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\nfunction beta() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["alpha", "beta"],
        diagnostics: [],
      }
      index.chunks.alpha = {
        ...chunk("alpha", "src.ts", [1, 0]),
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
      }
      index.chunks.beta = {
        ...chunk("beta", "src.ts", [0, 1]),
        range: { byteStart: 20, byteEnd: 38, lineStart: 2, lineEnd: 2 },
      }
      await store.write(index)

      const hydrated = await store.hydrateChunks(["beta", "missing", "alpha"])

      expect(Object.keys(hydrated.chunks)).toEqual(["beta", "alpha"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrateChunks empty input preserves active metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.updatedAt = 4321
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["alpha"],
        diagnostics: [],
      }
      index.chunks.alpha = {
        ...chunk("alpha", "src.ts", [1, 0]),
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
      }
      await store.write(index)
      await rm(sourcePath)

      const hydrated = await store.hydrateChunks([])

      expect(hydrated.metadata.status).toBe("ready")
      expect(hydrated.metadata.cacheKey).toBe("project")
      expect(hydrated.metadata.updatedAt).toBe(4321)
      expect(hydrated.files).toEqual({})
      expect(hydrated.chunks).toEqual({})
      expect(hydrated.symbols).toEqual({})
      expect(hydrated.diagnostics).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrateChunks loads only symbols referenced by hydrated chunks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const worktree = path.join(dir, "worktree")
      const sourcePath = path.join(worktree, "src.ts")
      await mkdir(worktree, { recursive: true })
      await Bun.write(sourcePath, "function alpha() {}\nfunction unrelated() {}\n")
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree,
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 2
      index.files["src.ts"] = {
        path: "src.ts",
        language: "typescript",
        fingerprint: await testFingerprint(sourcePath),
        chunkIds: ["alpha", "unrelated"],
        diagnostics: [],
      }
      index.chunks.alpha = {
        ...chunk("alpha", "src.ts", [1, 0]),
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        symbolIds: ["symbol-alpha"],
      }
      index.chunks.unrelated = {
        ...chunk("unrelated", "src.ts", [0, 1]),
        range: { byteStart: 20, byteEnd: 43, lineStart: 2, lineEnd: 2 },
        symbolIds: ["symbol-unrelated"],
      }
      index.symbols["symbol-alpha"] = {
        id: "symbol-alpha",
        name: "alpha",
        kind: "function",
        filePath: "src.ts",
        range: { byteStart: 0, byteEnd: 19, lineStart: 1, lineEnd: 1 },
        childSymbolIds: [],
      }
      index.symbols["symbol-unrelated"] = {
        id: "symbol-unrelated",
        name: "unrelated",
        kind: "function",
        filePath: "src.ts",
        range: { byteStart: 20, byteEnd: 43, lineStart: 2, lineEnd: 2 },
        childSymbolIds: [],
      }
      await store.write(index)

      const hydrated = await store.hydrateChunks(["alpha"])

      expect(Object.keys(hydrated.chunks)).toEqual(["alpha"])
      expect(Object.keys(hydrated.files)).toEqual(["src.ts"])
      expect(Object.keys(hydrated.symbols)).toEqual(["symbol-alpha"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("hydrateChunks empty input returns empty arrays", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 2 })

      const hydrated = await store.hydrateChunks([])

      expect(hydrated.metadata.status).toBe("empty")
      expect(hydrated.metadata.cacheKey).toBe("project")
      expect(hydrated.metadata.embeddingDimensions).toBe(2)
      expect(hydrated.files).toEqual({})
      expect(hydrated.chunks).toEqual({})
      expect(hydrated.symbols).toEqual({})
      expect(hydrated.diagnostics).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns empty index for corrupt SQLite persisted JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"

      await store.write(index)
      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        db.run("update runs set metadata_json = '{bad json'")
      } finally {
        db.close()
      }

      const cached = await createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 }).read()

      expect(cached.metadata.status).toBe("empty")
      expect(cached.metadata.diagnostics[0]).toContain("rebuilding corrupt index")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rethrows operational SQLite failures while reading the active run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.metadata.embeddingDimensions = 4
      index.chunks.c = chunk("c", "src/a.ts", [1, 0, 0, 0])
      await store.write(index)

      const db = new Database(path.join(dir, "project", "index.sqlite"))
      try {
        db.run("alter table chunks rename to chunks_old")
        db.run("create table chunks (run_id text not null, id text not null)")
      } finally {
        db.close()
      }

      await expect(
        createIndexStore({ cacheDir: dir, cacheKey: "project", embeddingDimensions: 4 }).read(),
      ).rejects.toThrow(MISSING_CHUNK_RECORD_COLUMN_PATTERN)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("writes and reads an index", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project" })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      await store.write(index)

      expect((await store.read()).metadata.status).toBe("ready")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reads valid lexical cache data", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const store = createIndexStore({ cacheDir: dir, cacheKey: "project" })
      const index = createEmptyIndex({
        projectId: "p",
        worktree: "/repo",
        cacheKey: "project",
        maxChunkNonWhitespaceChars: 2000,
      })
      index.metadata.status = "ready"
      index.lexical = {
        documentCount: 1,
        averageDocumentLength: 2,
        documentFrequencies: { alpha: 1 },
      }
      index.chunks.c = {
        id: "c",
        filePath: "src/a.ts",
        language: "typescript",
        kind: "function",
        range: { byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 },
        text: "alpha alpha",
        nonWhitespaceChars: 10,
        nodeTypes: [],
        symbolIds: [],
        childChunkIds: [],
        lexical: { length: 2, termFrequencies: { alpha: 2 } },
      }
      await store.write(index)

      const cached = await store.read()

      expect(cached.metadata.status).toBe("ready")
      expect(cached.lexical?.documentFrequencies.alpha).toBe(1)
      expect(cached.chunks.c.lexical?.termFrequencies.alpha).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("returns empty index without diagnostics for missing files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cast-store-"))
    try {
      const index = await createIndexStore({ cacheDir: dir, cacheKey: "project" }).read()

      expect(index.metadata.status).toBe("empty")
      expect(index.metadata.diagnostics).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("scores vectors by cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(
      searchVectors(
        [1, 0],
        [
          { id: "a", vector: [0, 1] },
          { id: "b", vector: [1, 0] },
        ],
        1,
      ),
    ).toEqual([{ id: "b", score: 1 }])
    expect(
      searchVectors(
        [1, 0],
        [
          { id: "a", vector: [0, 1] },
          { id: "b", vector: [1, 0] },
        ],
        -1,
      ),
    ).toEqual([])
  })
})
