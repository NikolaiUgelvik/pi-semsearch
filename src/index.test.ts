import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import packagedSemsearchExtension from "../extensions/pi-semsearch.ts"
import { createPiSemsearchExtensionForTest } from "./extension.js"
import semsearchExtension from "./index.js"
import { createEmptyIndex } from "./store.js"
import type { CastIndex, IndexMetadata, SearchOutput } from "./types.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("pi-semsearch extension", () => {
  test("root module exposes only the default extension", async () => {
    const entrypoint = await import("./index.js")

    expect(Object.keys(entrypoint)).toEqual(["default"])
    expect(entrypoint.default).toBeTypeOf("function")
  })

  test("package extension entry delegates to the root extension", () => {
    expect(packagedSemsearchExtension).toBe(semsearchExtension)
  })

  test("registers Pi tools and command", () => {
    const harness = installExtension(semsearchExtension)

    expect(Object.keys(harness.tools)).toEqual(["semantic_search_code", "semantic_get_chunk"])
    expect(Object.keys(harness.commands)).toEqual(["semsearch-refresh"])
    expect(harness.tools.semantic_search_code.description).toContain("by meaning instead of exact text")
    expect(harness.tools.semantic_search_code.promptGuidelines).toContain(
      "Use semantic_search_code as the default first tool for code discovery unless exact literal matching is required.",
    )
    expect(harness.tools.semantic_get_chunk.description).toContain("semantic_search_code")
    expect(harness.commands["semsearch-refresh"].description).toContain("Refresh the pi-semsearch code index")
  })

  test("session lifecycle starts indexing and disposes runtimes", async () => {
    const worktree = await tempWorktree({ embedding: configuredEmbedding() })
    let refreshes = 0
    const harness = installExtension(
      createPiSemsearchExtensionForTest({
        createStore: () => staleMetadataStore(worktree),
        createIndexer: () => ({
          refresh: async () => {
            refreshes += 1
          },
        }),
      }),
    )

    await harness.events.session_start?.({}, ctx(worktree))
    await eventually(() => expect(refreshes).toBe(1))

    await harness.commands["semsearch-refresh"].handler({}, ctx(worktree, harness.notifications))
    expect(refreshes).toBe(2)
    expect(harness.notifications).toContain("pi-semsearch index refreshed:info")

    await harness.events.session_shutdown?.({})
    await harness.events.session_start?.({}, ctx(worktree))
    await eventually(() => expect(refreshes).toBe(3))
  })

  test("semantic_search_code reports missing embedding configuration without breaking Pi startup", async () => {
    const worktree = await tempWorktree({})
    const harness = installExtension(createPiSemsearchExtensionForTest())

    const result = await executeTool(harness, "semantic_search_code", { query: "session" }, worktree)

    expect(result.content[0].text).toContain("Semantic code search is not configured")
    expect(result.content[0].text).toContain("embedding.model is required")
    expect(result.details).toEqual({ configured: false })
  })

  test("semantic_search_code returns Pi tool content and metadata from retrieval", async () => {
    const worktree = await tempWorktree({ embedding: configuredEmbedding() })
    const index = readyIndex(worktree)
    const harness = installExtension(
      createPiSemsearchExtensionForTest({
        createStore: () => readyStore(index),
        retrieve: async ({ input }) => searchOutput(index.metadata, input.query),
      }),
    )

    const result = await executeTool(harness, "semantic_search_code", { query: "find session" }, worktree)

    expect(result.content[0].text).toContain("Semantic code search: find session")
    expect(result.content[0].text).toContain("src/session.ts")
    expect(result.content[0].text).toContain("function session")
    expect(result.details).toMatchObject({ resultCount: 1, hydeUsed: false, rerankUsed: false })
  })

  test("semantic_get_chunk reads chunk context through the Pi tool API", async () => {
    const worktree = await tempWorktree({ embedding: configuredEmbedding() })
    const index = readyIndex(worktree)
    index.files["src/session.ts"] = {
      path: "src/session.ts",
      language: "typescript",
      fingerprint: "fp",
      chunkIds: ["c1"],
      diagnostics: [],
    }
    index.chunks.c1 = {
      id: "c1",
      filePath: "src/session.ts",
      language: "typescript",
      kind: "function",
      range: { byteStart: 0, byteEnd: 29, lineStart: 1, lineEnd: 1 },
      text: "export function session() {}",
      nonWhitespaceChars: 26,
      nodeTypes: ["function_declaration"],
      symbolIds: [],
      childChunkIds: [],
    }
    await mkdir(path.join(worktree, "src"), { recursive: true })
    await writeFile(path.join(worktree, "src", "session.ts"), "export function session() {}\n")
    const harness = installExtension(createPiSemsearchExtensionForTest({ createStore: () => readyStore(index) }))

    const result = await executeTool(harness, "semantic_get_chunk", { id: "c1", includeParents: false }, worktree)

    expect(result.content[0].text).toContain("Semantic chunk lookup: c1")
    expect(result.content[0].text).toContain("export function session")
    expect(result.details).toEqual({ found: true })
  })

  test("HyDE requires an active Pi model or explicit OpenAI-compatible provider", async () => {
    const worktree = await tempWorktree({ embedding: configuredEmbedding(), hyde: { enabled: true, threshold: 1 } })
    const index = readyIndex(worktree)
    let errorMessage = ""
    const harness = installExtension(
      createPiSemsearchExtensionForTest({
        createStore: () => readyStore(index),
        retrieve: async ({ generateHyde }) => {
          try {
            await generateHyde("session")
          } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
          }
          return searchOutput(index.metadata, "session")
        },
      }),
    )

    await executeTool(harness, "semantic_search_code", { query: "session" }, worktree)

    expect(errorMessage).toBe(
      "pi-semsearch HyDE requires either an active Pi model or explicit hyde.baseURL and hyde.model; set hyde.enabled=false to disable HyDE",
    )
  })

  test("HyDE can use Pi's active model", async () => {
    const worktree = await tempWorktree({ embedding: configuredEmbedding(), hyde: { enabled: true, threshold: 1 } })
    const index = readyIndex(worktree)
    let hydeText = ""
    const harness = installExtension(
      createPiSemsearchExtensionForTest({
        createStore: () => readyStore(index),
        complete: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "session lifecycle\nconversation state\nmessage branch" }],
          api: "test",
          provider: "test",
          model: "active-model",
          usage: testUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        }),
        retrieve: async ({ generateHyde }) => {
          hydeText = await generateHyde("session")
          return searchOutput(index.metadata, "session")
        },
      }),
    )

    await harness.tools.semantic_search_code.execute(
      "tool-call",
      { query: "session" },
      new AbortController().signal,
      undefined,
      ctx(worktree, [], { activeModel: true }),
    )

    expect(hydeText).toBe("session lifecycle\nconversation state\nmessage branch")
  })
})

interface TestToolRegistration {
  name: string
  description: string
  promptGuidelines?: string[]
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ReturnType<typeof ctx>,
  ) => Promise<{ content: Array<{ text: string }>; details: unknown }>
}

interface TestCommandRegistration {
  description: string
  handler: (args: Record<string, unknown>, ctx: ReturnType<typeof ctx>) => Promise<void>
}

interface TestEventHandlers {
  session_start?: (event: unknown, ctx: ReturnType<typeof ctx>) => Promise<void>
  session_shutdown?: (event: unknown) => Promise<void>
}

function installExtension(extension: (pi: never) => void) {
  const tools: Record<string, TestToolRegistration> = {}
  const commands: Record<string, TestCommandRegistration> = {}
  const events: TestEventHandlers = {}
  const notifications: string[] = []
  extension({
    on: (name: keyof TestEventHandlers, handler: TestEventHandlers[typeof name]) => {
      events[name] = handler
    },
    registerTool: (tool: TestToolRegistration) => {
      tools[tool.name] = tool
    },
    registerCommand: (name: string, command: TestCommandRegistration) => {
      commands[name] = command
    },
  } as never)
  return { tools, commands, events, notifications }
}

async function executeTool(
  harness: ReturnType<typeof installExtension>,
  name: "semantic_search_code" | "semantic_get_chunk",
  params: Record<string, unknown>,
  worktree: string,
) {
  return harness.tools[name].execute("tool-call", params, new AbortController().signal, undefined, ctx(worktree))
}

interface CtxOptions {
  activeModel?: boolean
}

function ctx(worktree: string, notifications: string[] = [], options: CtxOptions = {}) {
  return {
    cwd: worktree,
    ui: {
      setStatus: () => undefined,
      notify: (message: string, level: string) => notifications.push(`${message}:${level}`),
    },
    model: options.activeModel ? { id: "active-model", provider: "test" } : undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "active-key", headers: { "x-test": "1" } }),
    },
  }
}

async function tempWorktree(config: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-semsearch-"))
  tempDirs.push(dir)
  await mkdir(path.join(dir, ".pi"), { recursive: true })
  await writeFile(path.join(dir, ".pi", "semsearch.json"), JSON.stringify(config))
  return dir
}

function configuredEmbedding() {
  return { baseURL: "https://example.test/v1", apiKey: "key", model: "embed", dimensions: 2 }
}

function readyIndex(worktree: string): CastIndex {
  const index = createEmptyIndex({ projectId: "p", worktree, cacheKey: "cache", maxChunkNonWhitespaceChars: 2000 })
  index.metadata.status = "ready"
  index.metadata.maxFileBytes = 2 * 1024 * 1024
  index.metadata.includeGlobs = ["**/*"]
  index.metadata.excludeGlobs = defaultExcludeGlobs()
  return index
}

function readyStore(index: CastIndex) {
  return {
    readMetadata: async () => index.metadata,
    read: async () => index,
    write: async () => undefined,
  }
}

function staleMetadataStore(worktree: string) {
  return {
    readMetadata: async () => ({ ...readyIndex(worktree).metadata, status: "stale" as const }),
    read: async () => readyIndex(worktree),
    write: async () => undefined,
  }
}

function searchOutput(metadata: IndexMetadata, query: string): SearchOutput {
  return {
    status: {
      ...metadata,
      hydeUsed: false,
      rerankUsed: false,
      minFinalScore: 0.01,
      filteredCount: 1,
      candidateCount: 1,
    },
    results: [
      {
        filePath: "src/session.ts",
        language: "typescript",
        range: { byteStart: 0, byteEnd: 29, lineStart: 1, lineEnd: 1 },
        score: 0.9,
        finalScore: 0.95,
        kind: "function",
        breadcrumbs: ["function session"],
        text: `function session() { return ${JSON.stringify(query)} }`,
        topology: {
          chunk: { id: "c1", label: "function session", range: "src/session.ts:1-1" },
          children: [],
          symbols: ["function session"],
        },
        retrieval: { mode: "vector", vectorRank: 1 },
      },
    ],
    diagnostics: [],
  }
}

function testUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function defaultExcludeGlobs() {
  return [
    "**/*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,gz,tgz,tar,7z,mp4,mov,mp3,woff,woff2,ttf,eot}",
    "**/bun.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/*.min.js",
    "**/*.map",
    "**/__pycache__/**",
    "**/*.{pyc,pyo,pyd}",
    "**/.venv/**",
    "**/venv/**",
    "**/.mypy_cache/**",
    "**/.pytest_cache/**",
    "**/.ruff_cache/**",
    "**/.tox/**",
    "**/.nox/**",
    "**/*.egg-info/**",
    "**/coverage/**",
    "**/.next/**",
    "**/.nuxt/**",
    "**/.svelte-kit/**",
    "**/.turbo/**",
    "**/.vite/**",
    "**/.parcel-cache/**",
    "**/*.test",
    "**/coverage.out",
    "**/target/**",
    "**/.gradle/**",
    "**/*.{class,jar,war,ear}",
    "**/.bundle/**",
    "**/vendor/bundle/**",
    "**/vendor/**",
  ]
}

async function eventually(assertion: () => void, attempts = 10): Promise<void> {
  try {
    assertion()
  } catch (error) {
    if (attempts <= 1) {
      throw error
    }
    await waitForEventLoop()
    await eventually(assertion, attempts - 1)
  }
}

function waitForEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
