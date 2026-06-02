# Large Repo Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce large-repository indexing and retrieval bottlenecks without changing the cache schema or public search behavior.

**Architecture:** Keep the existing scanner, store, retriever, and plugin boundaries. Add small focused helpers for bounded traversal, compiled predicates, per-refresh symbol grouping, per-search source caching, bounded embedding pressure, transient embedding retries, and stricter startup metadata checks.

**Tech Stack:** Bun 1.3.14, TypeScript ESM, Biome, Tree-sitter, Bun SQLite/sqlite-vec, zod, minimatch.

---

## File Structure

- Modify `src/scanner.ts`: bounded directory traversal, compiled scan predicates, per-file symbol grouping, bounded reused-result writes, embedding backpressure, embedding batch concurrency option plumbing.
- Modify `src/scanner.test.ts`: scanner traversal, glob predicate, symbol reuse, embedding concurrency, and embedding backpressure tests.
- Modify `src/retriever.ts`: per-query source cache and lighter duplicate parent keys.
- Modify `src/retriever.test.ts`: source cache and duplicate parent range tests.
- Modify `src/chunk-lookup.test.ts`: child paging behavior test documenting response-side bounds and remaining store hydration risk.
- Modify `src/options.ts`: parse `embedding.concurrency`.
- Modify `src/options.test.ts`: embedding concurrency parse and invalid-value diagnostics.
- Modify `src/openai.ts`: transient retry/backoff for embedding requests only.
- Modify `src/openai.test.ts`: retryable and non-retryable embedding request tests.
- Modify `src/plugin.ts`: pass embedding concurrency to scanner and compare scanner-shape options at startup.
- Modify `src/index.test.ts`: startup freshness tests for `maxFileBytes`, `includeGlobs`, and `excludeGlobs`.
- Regenerate `dist/plugin.js` with `bun run build` after source changes.

### Task 1: Scanner Traversal And Compiled Predicates

**Files:**
- Modify: `src/scanner.ts:804-899`
- Test: `src/scanner.test.ts`

- [ ] **Step 1: Add failing traversal and predicate tests**

Add these tests near the existing scanner directory traversal tests in `src/scanner.test.ts`:

```ts
test("indexes deep files without traversing excluded subtrees", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
  try {
    let current = dir
    for (let index = 0; index < 40; index += 1) {
      current = path.join(current, `level-${index}`)
      await mkdir(current)
    }
    await Bun.write(path.join(current, "deep.ts"), "export const deepValue = 1\n")
    await mkdir(path.join(dir, "ignored", "nested"), { recursive: true })
    await Bun.write(path.join(dir, "ignored", "nested", "skip.ts"), "export const skipped = 1\n")

    const index = await createIndexer({
      worktree: dir,
      options: {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["**/*.ts"],
        excludeGlobs: ["ignored/**"],
        topK: 5,
        maxContextChars: 12_000,
      },
      store: createMemoryStore(),
      parse: async () => ({ language: "typescript", root: undefined }),
      embed: async () => [1, 0, 0],
    }).refresh()

    expect(Object.keys(index.files)).toEqual([
      `${Array.from({ length: 40 }, (_, index) => `level-${index}`).join("/")}/deep.ts`,
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("scan predicates preserve include and exclude glob semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
  try {
    await mkdir(path.join(dir, "src"), { recursive: true })
    await mkdir(path.join(dir, "vendor"), { recursive: true })
    await Bun.write(path.join(dir, "src", "keep.ts"), "export const keep = 1\n")
    await Bun.write(path.join(dir, "src", "drop.map"), "{}\n")
    await Bun.write(path.join(dir, "vendor", "skip.ts"), "export const skip = 1\n")

    const index = await createIndexer({
      worktree: dir,
      options: {
        maxChunkNonWhitespaceChars: 2000,
        includeGlobs: ["src/**"],
        excludeGlobs: ["**/*.map", "vendor/**"],
        topK: 5,
        maxContextChars: 12_000,
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
```

- [ ] **Step 2: Run scanner traversal tests and verify failure**

Run: `bun test --timeout 30000 src/scanner.test.ts -t "deep files|scan predicates"`

Expected: the new tests compile with the existing scanner test helpers and fail only if traversal behavior or predicate semantics are not yet implemented.

- [ ] **Step 3: Implement compiled scan predicates and bounded walk**

In `src/scanner.ts`, replace the `minimatch` import and `scanFiles`/`walk` helpers with a compiled-predicate implementation. Keep existing `loadGitignore`, `isGitignored`, and `toGitignorePath` behavior.

```ts
import { Minimatch } from "minimatch"

type ScanPredicates = {
  includes(filePath: string): boolean
  excludes(filePath: string): boolean
  excludesDirectory(relativePath: string): boolean
}

type WalkDirectory = { prefix: string; gitignores: GitignoreMatcher[] }

const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".cache"])
const DEFAULT_WALK_DIRECTORY_CONCURRENCY = 16

async function scanFiles(root: string, includeGlobs: string[], excludeGlobs: string[]) {
  const predicates = createScanPredicates(includeGlobs, excludeGlobs)
  const files = await walk(root, predicates)
  return files.filter((file) => predicates.includes(file) && !predicates.excludes(file))
}

function createScanPredicates(includeGlobs: string[], excludeGlobs: string[]): ScanPredicates {
  const includes = includeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }))
  const excludes = excludeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }))
  return {
    includes: (filePath) => includes.some((pattern) => pattern.match(filePath)),
    excludes: (filePath) => excludes.some((pattern) => pattern.match(filePath)),
    excludesDirectory: (relativePath) => {
      const globPath = toGitignorePath(relativePath)
      return excludes.some(
        (pattern) =>
          pattern.match(globPath) || pattern.match(`${globPath}/`) || pattern.match(`${globPath}/__placeholder__`),
      )
    },
  }
}

async function walk(root: string, predicates: ScanPredicates): Promise<string[]> {
  const files: string[] = []
  const directories: WalkDirectory[] = [{ prefix: "", gitignores: [] }]
  let next = 0

  const worker = async () => {
    while (next < directories.length) {
      const directory = directories[next]
      next += 1
      await walkDirectory(root, directory, predicates, directories, files)
    }
  }

  await Promise.all(Array.from({ length: DEFAULT_WALK_DIRECTORY_CONCURRENCY }, worker))
  return files
}

async function walkDirectory(
  root: string,
  directory: WalkDirectory,
  predicates: ScanPredicates,
  directories: WalkDirectory[],
  files: string[],
) {
  const entries = await readdir(path.join(root, directory.prefix), { withFileTypes: true })
  const localGitignore = await loadGitignore(root, directory.prefix)
  const gitignores = localGitignore ? [...directory.gitignores, localGitignore] : directory.gitignores
  for (const entry of entries) {
    const relative = path.join(directory.prefix, entry.name)
    if (
      DEFAULT_IGNORED_DIRECTORIES.has(entry.name) ||
      entry.isSymbolicLink() ||
      isGitignored(relative, gitignores) ||
      (entry.isDirectory() && predicates.excludesDirectory(relative))
    ) {
      continue
    }
    if (entry.isDirectory()) {
      directories.push({ prefix: relative, gitignores })
      continue
    }
    files.push(relative)
  }
}
```

Remove the old `isExcludedDirectory()` helper because `createScanPredicates().excludesDirectory` replaces it.

- [ ] **Step 4: Run scanner traversal tests and verify pass**

Run: `bun test --timeout 30000 src/scanner.test.ts -t "deep files|scan predicates"`

Expected: both new tests pass.

- [ ] **Step 5: Run focused scanner suite**

Run: `bun test --timeout 30000 src/scanner.test.ts`

Expected: all scanner tests pass.

- [ ] **Step 6: Commit scanner traversal changes**

```bash
git add src/scanner.ts src/scanner.test.ts
git commit -m "fix: bound scanner traversal"
```

### Task 2: Refresh Reuse Symbol Grouping And Bounded Reused Writes

**Files:**
- Modify: `src/scanner.ts:30-39`, `src/scanner.ts:87-153`, `src/scanner.ts:272-342`, `src/scanner.ts:699-730`
- Test: `src/scanner.test.ts`

- [ ] **Step 1: Add failing symbol reuse test**

Add this test to `src/scanner.test.ts` near existing reuse tests:

```ts
test("reuses file symbols through a per-file symbol index", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
  try {
    await Bun.write(path.join(dir, "a.ts"), "export function alpha() { return 1 }\n")
    await Bun.write(path.join(dir, "b.ts"), "export function beta() { return 2 }\n")
    let index = createEmptyIndex({ projectId: "p", worktree: dir, cacheKey: "key", maxChunkNonWhitespaceChars: 2000 })
    const parseCalls: string[] = []
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
```

- [ ] **Step 2: Run symbol reuse test and verify failure or current baseline**

Run: `bun test --timeout 30000 src/scanner.test.ts -t "per-file symbol index"`

Expected: if it passes immediately, keep it as a regression test and still implement the CPU improvement; if it fails, the failure should show lost reused symbols or unexpected reparsing.

- [ ] **Step 3: Implement `SymbolsByFilePath` and use it in reuse validation**

In `src/scanner.ts`, add the type and map builder:

```ts
type SymbolsByFilePath = Map<string, SymbolRecord[]>

function symbolsByFilePath(symbols: Record<string, SymbolRecord>): SymbolsByFilePath {
  const grouped: SymbolsByFilePath = new Map()
  for (const symbol of Object.values(symbols)) {
    const symbolsForFile = grouped.get(symbol.filePath)
    if (symbolsForFile) {
      symbolsForFile.push(symbol)
    } else {
      grouped.set(symbol.filePath, [symbol])
    }
  }
  return grouped
}
```

Extend `RefreshState` with `symbolsByFilePath: SymbolsByFilePath`, initialize it after `store.read()` with `symbolsByFilePath(index.symbols)`, and update function signatures:

```ts
type RefreshState = {
  nextFiles: CastIndex["files"]
  nextChunks: CastIndex["chunks"]
  nextSymbols: CastIndex["symbols"]
  metadataDiagnostics: string[]
  metadataDiagnosticDetails: DiagnosticRecord[]
  reusedFileResults: FileResult[]
  symbolsByFilePath: SymbolsByFilePath
  canReuseExistingRecords: boolean
  changed: boolean
}
```

Change reuse calls to pass the grouped symbols:

```ts
canReuseFile(input.index, previousFile, input.relativePath, currentFingerprint, input.state.canReuseExistingRecords, input.state.symbolsByFilePath)
reuseFileRecords(input.index, previousFile, input.state)
```

Change `reuseFileRecords()` and `canReuseFile()` internals:

```ts
function reuseFileRecords(index: CastIndex, file: FileRecord, state: RefreshState) {
  state.nextFiles[file.path] = file
  const chunks: Record<string, ChunkRecord> = {}
  for (const chunkId of file.chunkIds) {
    if (index.chunks[chunkId]) {
      state.nextChunks[chunkId] = index.chunks[chunkId]
      chunks[chunkId] = index.chunks[chunkId]
    }
  }
  const symbols: Record<string, SymbolRecord> = {}
  for (const symbol of state.symbolsByFilePath.get(file.path) ?? []) {
    state.nextSymbols[symbol.id] = symbol
    symbols[symbol.id] = symbol
  }
  state.reusedFileResults.push({ file, chunks, symbols })
}

function canReuseFile(
  index: CastIndex,
  file: CastIndex["files"][string] | undefined,
  relativePath: string,
  fingerprint: string,
  canReuseExistingRecords: boolean,
  groupedSymbols: SymbolsByFilePath = symbolsByFilePath(index.symbols),
) {
  // keep existing chunk checks unchanged
  return (groupedSymbols.get(file.path) ?? []).every((symbol) => validSymbolRecord(index, symbol, file.path))
}
```

Keep the existing chunk validation body intact; only replace the final per-file symbol scan that currently filters `Object.values(index.symbols)` by `symbol.filePath === file.path`.

- [ ] **Step 4: Stream reused file results once an index run exists**

Replace `persistReusedFileResults()` usage with immediate writer calls for run-backed refreshes. In `reuseFileRecords()`, after constructing `fileResult`, push to `reusedFileResults` only when `input.run()` is absent; otherwise write through `fileResultWriter.add(fileResult)` from `processScannedFile()`.

Use this call pattern in `processScannedFile()`:

```ts
if (
  canReuseFile(
    input.index,
    previousFile,
    input.relativePath,
    currentFingerprint,
    input.state.canReuseExistingRecords,
    input.state.symbolsByFilePath,
  )
) {
  const reused = reuseFileRecords(input.index, previousFile, input.state)
  if (input.run()) {
    await input.fileResultWriter.add(reused)
  } else {
    input.state.reusedFileResults.push(reused)
  }
  return input.state.changed
}
```

Change `reuseFileRecords()` to return `FileResult` and remove its direct push.

- [ ] **Step 5: Run focused reuse test**

Run: `bun test --timeout 30000 src/scanner.test.ts -t "per-file symbol index"`

Expected: test passes.

- [ ] **Step 6: Run focused scanner suite**

Run: `bun test --timeout 30000 src/scanner.test.ts`

Expected: all scanner tests pass.

- [ ] **Step 7: Commit refresh reuse changes**

```bash
git add src/scanner.ts src/scanner.test.ts
git commit -m "fix: reduce refresh reuse scans"
```

### Task 3: Retrieval Source Cache And Output Memory Keys

**Files:**
- Modify: `src/retriever.ts:355-459`
- Test: `src/retriever.test.ts`

- [ ] **Step 1: Add failing per-search source cache test**

Add this test to `src/retriever.test.ts` near output/result tests:

```ts
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
    kind: "declaration",
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
    kind: "declaration",
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
```

- [ ] **Step 2: Run retrieval cache test and verify failure**

Run: `bun test --timeout 30000 src/retriever.test.ts -t "shared result source"`

Expected: failure shows `reads` is `2` before caching.

- [ ] **Step 3: Implement source cache**

In `src/retriever.ts`, introduce a `SourceCache` type and pass it through `outputResults()`:

```ts
type SourceReadResult = { text: string; ok: true } | { text: string; ok: false }
type SourceCache = Map<string, Promise<SourceReadResult>>

async function outputResults(input: {
  input: ResultOutputContext
  results: RankedResult[]
  chunksById: Record<string, ChunkRecord>
  diagnostics: string[]
  diagnosticDetails: DiagnosticRecord[]
  initialScores: Record<string, number>
  maxContextChars: number
  retrieval: Map<string, SearchResultRetrievalDetails>
}) {
  const sourceCache: SourceCache = new Map()
  const results = await Promise.all(input.results.flatMap((result) => outputResult(input, result, sourceCache)))
  return omitDuplicateParentRanges(results.flat())
}

async function outputResult(input: Parameters<typeof outputResults>[0], result: RankedResult, sourceCache: SourceCache) {
  const chunk = input.chunksById[result.id]
  if (!chunk) {
    return []
  }
  const source = await sourceForChunk(input.input, chunk, input.diagnostics, input.diagnosticDetails, sourceCache)
  // keep the rest of outputResult unchanged
}

function sourceForChunk(
  input: ResultOutputContext,
  chunk: ChunkRecord,
  diagnostics: string[],
  diagnosticDetails: DiagnosticRecord[],
  sourceCache: SourceCache,
) {
  const cached = sourceCache.get(chunk.filePath)
  if (cached) {
    return cached
  }
  const source = input
    .readSource(chunk.filePath)
    .then((text) => ({ text, ok: true as const }))
    .catch(() => {
      addSourceDiagnostic(diagnostics, diagnosticDetails, {
        chunk,
        code: "source.read_failed",
        message: `source read failed for ${chunk.filePath}; parent context omitted`,
      })
      return { text: "", ok: false as const }
    })
  sourceCache.set(chunk.filePath, source)
  return source
}
```

- [ ] **Step 4: Change duplicate parent key**

In `omitDuplicateParentRange()`, replace the key expression with file and byte range only:

```ts
const key = `${result.filePath}\0${result.parentRange.byteStart}\0${result.parentRange.byteEnd}`
```

Do not include `parentText` in the key.

- [ ] **Step 5: Run retrieval tests**

Run: `bun test --timeout 30000 src/retriever.test.ts`

Expected: all retrieval tests pass.

- [ ] **Step 6: Commit retrieval output changes**

```bash
git add src/retriever.ts src/retriever.test.ts
git commit -m "fix: cache retrieval source reads"
```

### Task 4: Chunk Lookup Child Page Regression

**Files:**
- Modify: `src/chunk-lookup.test.ts`
- Modify only if needed: `src/chunk-lookup.ts:146-210`

- [ ] **Step 1: Add child-page response bound test**

Add this test to `src/chunk-lookup.test.ts` near child pagination tests:

```ts
test("returns only requested child page entries", async () => {
  const index = createEmptyIndex({
    projectId: "p",
    worktree: "/repo",
    cacheKey: "key",
    maxChunkNonWhitespaceChars: 2000,
  })
  index.metadata.status = "ready"
  const source = ["function parent() {", ...Array.from({ length: 50 }, (_, child) => `  child${child}()`), "}"].join("\n")
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
```

- [ ] **Step 2: Run lookup child test**

Run: `bun test --timeout 30000 src/chunk-lookup.test.ts -t "requested child page"`

Expected: test passes if response assembly is already bounded. If it fails, fix only `childPage()` or `relatedChunks()` so only requested child IDs are mapped to related output.

- [ ] **Step 3: Document remaining store-side over-hydration in test name or assertion**

If the test passes without production changes, keep it as regression coverage. Add a test comment:

```ts
// Store hydration may still load full topology before this function receives the index;
// this test protects the response assembly boundary until store-side paging is added.
```

- [ ] **Step 4: Run lookup suite**

Run: `bun test --timeout 30000 src/chunk-lookup.test.ts`

Expected: all lookup tests pass.

- [ ] **Step 5: Commit lookup regression coverage**

```bash
git add src/chunk-lookup.ts src/chunk-lookup.test.ts
git commit -m "test: cover chunk child paging"
```

### Task 5: Embedding Concurrency, Backpressure, And Retries

**Files:**
- Modify: `src/options.ts:13-15`, `src/options.ts:146-160`, `src/options.ts:182-196`, `src/options.ts:271-279`
- Modify: `src/scanner.ts:67-82`, `src/scanner.ts:489-612`
- Modify: `src/openai.ts:41-60`, `src/openai.ts:110-116`
- Test: `src/options.test.ts`, `src/scanner.test.ts`, `src/openai.test.ts`

- [ ] **Step 1: Add option parsing tests**

Add to `src/options.test.ts`:

```ts
test("parses embedding concurrency", () => {
  const options = parseOptions({
    embedding: { baseURL: "https://example.test/v1", model: "embed", concurrency: 3 },
  })

  expect(options.embedding?.concurrency).toBe(3)
})

test("rejects invalid embedding concurrency", () => {
  const options = parseOptions({
    embedding: { baseURL: "https://example.test/v1", model: "embed", concurrency: 0 },
  })

  expect(options.diagnostics).toContain("embedding.concurrency: Number must be greater than 0")
})
```

- [ ] **Step 2: Add scanner embedding concurrency test**

Add to `src/scanner.test.ts` near embedding batch tests:

```ts
test("limits embedding batches to configured concurrency", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cast-indexer-"))
  try {
    await Bun.write(path.join(dir, "many.txt"), Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"))
    let active = 0
    let maxActive = 0

    await createIndexer({
      worktree: dir,
      options: {
        maxChunkNonWhitespaceChars: 8,
        includeGlobs: ["**/*.txt"],
        excludeGlobs: [],
        topK: 5,
        maxContextChars: 12_000,
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
```

- [ ] **Step 3: Add embedding retry tests**

Add to `src/openai.test.ts`:

```ts
test("retries transient embedding failures", async () => {
  let calls = 0
  const client = createOpenAIClient({
    fetch: async () => {
      calls += 1
      if (calls === 1) {
        return new Response("rate limited", { status: 429 })
      }
      return Response.json({ data: [{ embedding: [1, 0, 0] }] })
    },
  })

  await expect(
    client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "text" }),
  ).resolves.toEqual([1, 0, 0])
  expect(calls).toBe(2)
})

test("does not retry permanent embedding failures", async () => {
  let calls = 0
  const client = createOpenAIClient({
    fetch: async () => {
      calls += 1
      return new Response("bad request", { status: 400 })
    },
  })

  await expect(
    client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "text" }),
  ).rejects.toThrow("Embedding request failed: 400")
  expect(calls).toBe(1)
})
```

- [ ] **Step 4: Run new tests and verify failure**

Run: `bun test --timeout 30000 src/options.test.ts -t "embedding concurrency" && bun test --timeout 30000 src/scanner.test.ts -t "configured concurrency" && bun test --timeout 30000 src/openai.test.ts -t "embedding failures"`

Expected: at least option and scanner concurrency tests fail before implementation; retry test fails with one call and thrown `429`.

- [ ] **Step 5: Parse and pass embedding concurrency**

In `src/options.ts`, extend `EmbeddingConfig` and `embeddingOptions()`:

```ts
const EmbeddingConfig = ApiConfig.extend({
  batchSize: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
})

function embeddingOptions(raw: ReturnType<typeof rawOptions>["embedding"], apiKey: string | undefined) {
  return raw?.baseURL && raw.model
    ? {
        baseURL: raw.baseURL,
        apiKey,
        model: raw.model,
        dimensions: raw.dimensions,
        batchSize: raw.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
        concurrency: raw.concurrency ?? 1,
      }
    : undefined
}
```

In `src/scanner.ts`, add `embeddingBatchConcurrency?: number` to indexer options and use it:

```ts
embeddingBatchConcurrency?: number

const maxOutstanding = Math.max(1, input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY)
```

In `src/plugin.ts`, pass `embedding.concurrency` into `createIndexer()` options next to `embeddingBatchSize`.

- [ ] **Step 6: Add bounded per-file embedding producer**

Replace the current `Promise.all` loop over every chunk in `embedChunks()` with a bounded worker loop:

```ts
async function embedChunks(input: {
  input: CreateIndexerInput
  relativePath: string
  parsed: { language: string }
  chunks: ChunkRecord[]
  symbolsById: Record<string, SymbolRecord>
  fileDiagnostics: string[]
  embeddingBatcher: EmbeddingBatcher
}) {
  const fileChunks: CastIndex["chunks"] = {}
  const embeddedChunks: { chunk: ChunkRecord; embedded: EmbeddingResult }[] = []
  const concurrency = Math.max(1, input.input.options.embeddingBatchConcurrency ?? DEFAULT_EMBEDDING_BATCH_CONCURRENCY)
  let next = 0

  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.chunks.length) }, async () => {
      while (next < input.chunks.length) {
        const chunk = input.chunks[next]
        next += 1
        const embedded = await input.embeddingBatcher.embed(
          embeddingText(
            input.relativePath,
            input.parsed.language,
            chunk,
            input.symbolsById,
            input.input.options.chunking.expansion,
          ),
        )
        embeddedChunks.push({ chunk, embedded })
      }
    }),
  )

  for (const { chunk, embedded } of embeddedChunks) {
    if ("embeddingError" in embedded) {
      input.fileDiagnostics.push(`embedding failed: ${embedded.embeddingError}`)
    }
    fileChunks[chunk.id] = { ...chunk, ...embedded }
  }
  return fileChunks
}
```

- [ ] **Step 7: Add embedding retry for transient HTTP failures**

In `src/openai.ts`, add retry helpers and use them only for `requestEmbeddings()`:

```ts
const EMBEDDING_RETRY_ATTEMPTS = 2
const EMBEDDING_RETRY_BASE_DELAY_MS = 25

async function requestEmbeddings(
  request: FetchLike,
  input: { baseURL: string; apiKey?: string; model: string; dimensions?: number; input: string | string[] },
) {
  return requestJsonWithRetry(
    request,
    `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/embeddings`,
    {
      method: "POST",
      headers: buildHeaders(input.apiKey),
      body: JSON.stringify({
        model: input.model,
        input: input.input,
        ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
      }),
    },
    "Embedding",
    EMBEDDING_RETRY_ATTEMPTS,
  )
}

async function requestJsonWithRetry(
  request: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
  attempts: number,
) {
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const response = await request(url, init)
    if (response.ok) {
      return response.json().catch(() => undefined)
    }
    if (!isRetryableStatus(response.status) || attempt === attempts) {
      throw new Error(`${label} request failed: ${response.status}`)
    }
    await delay(retryDelayMs(attempt))
  }
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function retryDelayMs(attempt: number) {
  return EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * EMBEDDING_RETRY_BASE_DELAY_MS)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

Leave `generateHyde()` and `rerank()` on `requestJson()` unless tests require shared behavior.

- [ ] **Step 8: Run embedding-related suites**

Run: `bun test --timeout 30000 src/options.test.ts src/scanner.test.ts src/openai.test.ts`

Expected: all three suites pass.

- [ ] **Step 9: Commit embedding changes**

```bash
git add src/options.ts src/options.test.ts src/scanner.ts src/scanner.test.ts src/openai.ts src/openai.test.ts src/plugin.ts
git commit -m "fix: tune embedding throughput"
```

### Task 6: Startup Freshness Checks

**Files:**
- Modify: `src/plugin.ts:724-735`
- Test: `src/index.test.ts`

- [ ] **Step 1: Add failing startup freshness tests**

Add these tests near existing startup refresh metadata tests in `src/index.test.ts`:

```ts
test("startup refreshes when maxFileBytes differs", async () => {
  let refreshes = 0
  const ready = emptyReadyIndex()
  ready.metadata.maxFileBytes = 123
  const plugin = createCastPluginForTest({
    createIndexer: () => ({ refresh: async () => { refreshes += 1; return emptyReadyIndex() } }),
    createStore: () => ({ readMetadata: async () => ready.metadata, read: async () => ready, write: async () => undefined }),
  })

  await plugin(input as never, {
    embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    maxFileBytes: 456,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(refreshes).toBe(1)
})

test("startup refreshes when includeGlobs differ", async () => {
  let refreshes = 0
  const ready = emptyReadyIndex()
  ready.metadata.includeGlobs = ["src/**"]
  const plugin = createCastPluginForTest({
    createIndexer: () => ({ refresh: async () => { refreshes += 1; return emptyReadyIndex() } }),
    createStore: () => ({ readMetadata: async () => ready.metadata, read: async () => ready, write: async () => undefined }),
  })

  await plugin(input as never, {
    embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    includeGlobs: ["lib/**"],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(refreshes).toBe(1)
})

test("startup refreshes when excludeGlobs differ", async () => {
  let refreshes = 0
  const ready = emptyReadyIndex()
  ready.metadata.excludeGlobs = ["vendor/**"]
  const plugin = createCastPluginForTest({
    createIndexer: () => ({ refresh: async () => { refreshes += 1; return emptyReadyIndex() } }),
    createStore: () => ({ readMetadata: async () => ready.metadata, read: async () => ready, write: async () => undefined }),
  })

  await plugin(input as never, {
    embedding: { baseURL: "https://example.test/v1", apiKey: "key", model: "embed" },
    excludeGlobs: ["dist/**"],
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(refreshes).toBe(1)
})
```

- [ ] **Step 2: Run startup freshness tests and verify failure**

Run: `bun test --timeout 30000 src/index.test.ts -t "startup refreshes when"`

Expected: tests fail with `refreshes` equal to `0` before implementation.

- [ ] **Step 3: Compare scanner-shape metadata in `canUseReadyIndexForStartup()`**

In `src/plugin.ts`, update the function:

```ts
function canUseReadyIndexForStartup(
  metadata: IndexMetadata,
  worktree: string,
  options: ReturnType<typeof parseOptions>,
) {
  return (
    metadata.status === "ready" &&
    metadata.worktree === worktree &&
    metadata.maxFileBytes === options.maxFileBytes &&
    sameStringArray(metadata.includeGlobs, options.includeGlobs) &&
    sameStringArray(metadata.excludeGlobs, options.excludeGlobs) &&
    metadata.maxChunkNonWhitespaceChars === options.maxChunkNonWhitespaceChars &&
    sameStartupChunking(metadata.chunking, options.chunking)
  )
}
```

If `sameStringArray()` is not in scope in `src/plugin.ts`, add the same helper shape used in `src/scanner.ts`:

```ts
function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
```

- [ ] **Step 4: Run startup freshness tests**

Run: `bun test --timeout 30000 src/index.test.ts -t "startup refreshes when"`

Expected: all three tests pass.

- [ ] **Step 5: Run full index test suite**

Run: `bun test --timeout 30000 src/index.test.ts`

Expected: all index tests pass.

- [ ] **Step 6: Commit startup freshness changes**

```bash
git add src/plugin.ts src/index.test.ts
git commit -m "fix: refresh stale startup indexes"
```

### Task 7: Build Output And Final Verification

**Files:**
- Modify: `dist/plugin.js`
- Verify: all changed files

- [ ] **Step 1: Regenerate build output**

Run: `bun run build`

Expected: `tsc` exits with status `0` and `dist/plugin.js` updates if source changed.

- [ ] **Step 2: Commit build output**

```bash
git add dist/plugin.js
git commit -m "build: update plugin bundle"
```

If `dist/plugin.js` has no diff, skip this commit and record that no build output changed.

- [ ] **Step 3: Run final verification**

Run these commands:

```bash
bun run typecheck
bun run lint
bun run build
bun test --timeout 30000
```

Expected:
- `bun run typecheck` exits with status `0`.
- `bun run lint` exits with status `0` and reports no fixes.
- `bun run build` exits with status `0`.
- `bun test --timeout 30000` exits with status `0`.

- [ ] **Step 4: Inspect final status and diff**

Run:

```bash
git status --short
git diff
git log --oneline -10
```

Expected: working tree is clean, or only intentional uncommitted files remain. Recent commits include the task commits above.
