import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { env } from "node:process"
import { complete, type UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getChunkById } from "./chunk-lookup.js"
import { HYDE_SYSTEM_PROMPT } from "./hyde.js"
import { parseSource } from "./language.js"
import { createOpenAIClient, type FetchLike } from "./openai.js"
import { parseOptions } from "./options.js"
import { type RetrievalIndexStore, retrieveFromStore } from "./retriever.js"
import { createIndexer } from "./scanner.js"
import { createIndexStore } from "./store.js"
import type {
  CastIndex,
  ChunkLookupOutput,
  DiagnosticRecord,
  HydratedChunkSet,
  IndexMetadata,
  LexicalChunkCandidate,
  SearchOutput,
} from "./types.js"

interface VectorCandidateStore {
  searchVectorCandidates(
    queryEmbedding: number[],
    topK: number,
    paths?: string[],
  ): Promise<Array<{ id: string; score: number }> & { incomplete?: boolean }>
}

interface LexicalCandidateStore {
  searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>
}

type IndexingStore = Parameters<typeof createIndexer>[0]["store"]
type WrappedIndexingStore = IndexingStore & Partial<VectorCandidateStore>

interface SemsearchRuntimeDependencies {
  fetch?: FetchLike
  createStore?: typeof createIndexStore
  createIndexer?: typeof createIndexer
  retrieve?: typeof retrieveFromStore
  complete?: typeof complete
}

interface ToolOutputLimits {
  maxLines?: number
  maxBytes?: number
}

const SEMSEARCH_STATUS_KEY = "semsearch"
const SEMSEARCH_INDEXING_STATUS = "pi-semsearch indexing"
const COMPACTION_DIAGNOSTIC = "output compacted; use semantic_get_chunk for more context"
const INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; results may be stale"
const INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC =
  "index refresh in progress; no searchable active index is available yet"
const LOOKUP_COMPACTION_DIAGNOSTIC =
  "output compacted; narrow semantic_get_chunk args, page children, or reduce included relations"
const HYDE_PROVIDER_ERROR =
  "pi-semsearch HyDE requires either an active Pi model or explicit hyde.baseURL and hyde.model; set hyde.enabled=false to disable HyDE"
const LONG_COMPACT_TEXT_LENGTH = 200
const MEDIUM_COMPACT_TEXT_LENGTH = 80
const SHORT_COMPACT_TEXT_LENGTH = 20
const OMITTED_TEXT_LENGTH = 0
const MANY_COMPACT_CHILDREN = 5
const SINGLE_COMPACT_CHILD = 1
const MAX_DIAGNOSTIC_SAMPLES = 5
const NO_COMPACT_CHILDREN = 0
const SEARCH_COMPACT_TEXT_LENGTHS = [
  LONG_COMPACT_TEXT_LENGTH,
  MEDIUM_COMPACT_TEXT_LENGTH,
  SHORT_COMPACT_TEXT_LENGTH,
  OMITTED_TEXT_LENGTH,
]
const LOOKUP_COMPACT_TEXT_LENGTHS = [LONG_COMPACT_TEXT_LENGTH, MEDIUM_COMPACT_TEXT_LENGTH, OMITTED_TEXT_LENGTH]
const LOOKUP_COMPACT_CHILD_LIMITS = [
  Number.MAX_SAFE_INTEGER,
  MANY_COMPACT_CHILDREN,
  SINGLE_COMPACT_CHILD,
  NO_COMPACT_CHILDREN,
]

class IndexUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IndexUnavailableError"
  }
}

class SemsearchRuntime {
  private readonly client: ReturnType<typeof createOpenAIClient>
  private readonly lifecycle = new AbortController()
  private readonly worktree: string
  private readonly options: ReturnType<typeof parseOptions>
  private readonly dependencies: SemsearchRuntimeDependencies
  private readonly store: ReturnType<typeof createIndexStore> | undefined
  private storeError: string | undefined
  private refresh: Promise<unknown> | undefined
  private forcedRefresh: Promise<unknown> | undefined
  private refreshTail = Promise.resolve()

  constructor(input: {
    worktree: string
    options: ReturnType<typeof parseOptions>
    dependencies?: SemsearchRuntimeDependencies
  }) {
    this.worktree = input.worktree
    this.options = input.options
    this.dependencies = input.dependencies ?? {}
    this.client = createOpenAIClient(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {})
    try {
      this.store = (this.dependencies.createStore ?? createIndexStore)({
        cacheDir: this.options.cacheDir,
        cacheKey: createHash("sha256")
          .update(
            JSON.stringify({
              projectId: createProjectId(this.worktree),
              worktree: this.worktree,
              embedding: this.options.embedding
                ? {
                    baseURL: this.options.embedding.baseURL,
                    model: this.options.embedding.model,
                    dimensions: this.options.embedding.dimensions,
                  }
                : "missing",
              maxChunkNonWhitespaceChars: this.options.maxChunkNonWhitespaceChars,
            }),
          )
          .digest("hex"),
        embeddingDimensions: this.options.embedding?.dimensions,
      })
    } catch (error) {
      this.storeError = formatThrownError(error)
    }
  }

  async start() {
    await queueInitialRefresh({
      options: this.options,
      worktree: this.worktree,
      store: this.store,
      queueRefresh: (input) => this.queueRefresh(input),
    })
  }

  dispose() {
    this.lifecycle.abort()
    this.refresh = undefined
    this.forcedRefresh = undefined
    this.refreshTail = Promise.resolve()
  }

  queueRefresh(refreshInput: { background?: boolean; forced?: boolean } = {}) {
    const embedding = this.options.embedding
    if (!(embedding && this.store) || this.storeError) {
      return Promise.resolve()
    }
    if (refreshInput.forced && this.forcedRefresh) {
      return this.forcedRefresh
    }
    const indexStore = this.store
    const nextRefresh = this.refreshTail
      .then(() => {
        this.lifecycle.signal.throwIfAborted()
        if (this.storeError) {
          return
        }
        const indexingStore = this.wrapIndexingStore(indexStore)
        return (this.dependencies.createIndexer ?? createIndexer)({
          worktree: this.worktree,
          options: {
            maxChunkNonWhitespaceChars: this.options.maxChunkNonWhitespaceChars,
            maxFileBytes: this.options.maxFileBytes,
            includeGlobs: this.options.includeGlobs,
            excludeGlobs: this.options.excludeGlobs,
            chunking: this.options.chunking,
            embeddingBatchSize: embedding.batchSize,
            embeddingBatchConcurrency: embedding.concurrency,
          },
          store: indexingStore,
          parse: parseSource,
          embed: (text, signal) => this.client.embed({ ...embedding, input: text, signal }),
          embedBatch: (texts, signal) => this.client.embedBatch({ ...embedding, input: texts, signal }),
        }).refresh(this.lifecycle.signal)
      })
      .catch((error) => {
        if (error instanceof IndexUnavailableError) {
          this.storeError = error.message
          return
        }
        if (!refreshInput.background) {
          throw error
        }
      })
    this.refresh = nextRefresh
    if (refreshInput.forced) {
      this.forcedRefresh = nextRefresh
    }
    nextRefresh.then(
      () => this.clearRefresh(nextRefresh),
      () => this.clearRefresh(nextRefresh),
    )
    this.refreshTail = nextRefresh.then(
      () => undefined,
      () => undefined,
    )
    return nextRefresh
  }

  async semanticSearchOutput(
    args: Parameters<typeof retrieveFromStore>[0]["input"],
    signal?: AbortSignal,
    ctx?: Pick<ExtensionContext, "model" | "modelRegistry">,
  ) {
    const embedding = this.options.embedding
    if (!embedding) {
      throw new Error("embedding dependency unavailable")
    }
    const readiness = await ensureSearchIndexReady(
      args.refresh === true,
      (input) => this.queueRefresh(input),
      () => this.refresh,
      () => this.storeError,
    )
    try {
      const output = await (this.dependencies.retrieve ?? retrieveFromStore)({
        input: args,
        options: {
          ...this.options,
          hybrid: this.options.retrieval.hybrid,
          rerank: this.options.rerank,
          maxVectorCandidates: this.options.retrieval.maxVectorCandidates,
          maxRerankCandidates: this.options.retrieval.maxRerankCandidates,
        },
        embed: (text) => this.client.embed({ ...embedding, input: text, signal }),
        generateHyde: (query) => this.generateHydeText(query, signal, ctx),
        rerank: (query, documents) =>
          rerankDocuments({ query, documents, rerank: this.options.rerank, client: this.client, signal }),
        readSource: async (filePath) => readFile(await resolveWorktreePath(this.worktree, filePath), "utf8"),
        indexStore: this.retrievalIndexStore(),
      })
      return readiness.refreshInProgress ? appendSearchDiagnostic(output, INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC) : output
    } catch (error) {
      if (!(error instanceof IndexUnavailableError)) {
        throw error
      }
      throw new IndexUnavailableError(this.storeError ?? formatThrownError(error))
    }
  }

  async lookupChunk(args: Parameters<typeof getChunkById>[0]["input"]) {
    if (!this.options.embedding) {
      return {
        title: "Semantic chunk lookup is not configured",
        output: this.options.diagnostics.join("\n"),
        metadata: { configured: false },
      }
    }
    if (!this.store) {
      return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError)
    }
    await this.refresh
    if (this.storeError) {
      return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError)
    }
    let output: Awaited<ReturnType<typeof getChunkById>>
    try {
      output = await getChunkById({
        index: await this.readChunkLookupIndex(args.id),
        input: args,
        readSource: async (filePath) => readFile(await resolveWorktreePath(this.worktree, filePath), "utf8"),
      })
    } catch (error) {
      if (!(error instanceof IndexUnavailableError)) {
        throw error
      }
      return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError)
    }
    const toolOutput = chunkLookupOutputForTool(output)
    return {
      title: `Semantic chunk lookup: ${args.id}`,
      output: serializeToolOutput({
        output: toolOutput,
        limits: {},
        compact: compactChunkLookupOutput,
        minimal: minimalChunkLookupOutput,
        diagnosticsFocused: diagnosticsFocusedChunkLookupOutput,
      }),
      metadata: { found: Boolean(output.chunk) },
    }
  }

  semanticSearchUnavailable() {
    if (!this.options.embedding) {
      return {
        title: "Semantic code search is not configured",
        output: this.options.diagnostics.join("\n"),
        metadata: { configured: false },
      }
    }
    return this.store ? undefined : unavailableToolResult("Semantic code search index unavailable", this.storeError)
  }

  searchToolResult(query: string, output: SearchOutput, limits: ToolOutputLimits = {}) {
    const toolOutput = searchOutputForTool(output)
    return {
      title: `Semantic code search: ${query}`,
      output: serializeToolOutput({
        output: toolOutput,
        limits,
        compact: compactSearchOutput,
        minimal: minimalSearchOutput,
        diagnosticsFocused: diagnosticsFocusedSearchOutput,
      }),
      metadata: {
        hydeUsed: output.status.hydeUsed,
        rerankUsed: output.status.rerankUsed,
        resultCount: output.results.length,
        minFinalScore: output.status.minFinalScore,
        filteredCount: output.status.filteredCount,
      },
    }
  }

  refreshAfterWrite(filePath: string) {
    if (this.semanticSearchUnavailable() || !isWorktreePath(this.worktree, filePath)) {
      return
    }
    return this.queueRefresh({ background: true })
  }

  currentRefresh() {
    return this.refresh
  }

  private clearRefresh(refresh: Promise<unknown>) {
    if (this.refresh === refresh) {
      this.refresh = undefined
    }
    if (this.forcedRefresh === refresh) {
      this.forcedRefresh = undefined
    }
  }

  private recordStoreUnavailable(error: unknown) {
    if (!isStoreUnavailableError(error)) {
      return false
    }
    this.storeError = formatThrownError(error)
    return true
  }

  private async readIndex() {
    if (!this.store) {
      throw new Error(this.storeError ?? "index unavailable")
    }
    try {
      return await this.store.read()
    } catch (error) {
      if (!this.recordStoreUnavailable(error)) {
        throw error
      }
      throw new IndexUnavailableError(this.storeError ?? formatThrownError(error))
    }
  }

  private async readChunkLookupIndex(id: string) {
    if (!this.store) {
      throw new Error(this.storeError ?? "index unavailable")
    }
    if (!hasHydrateChunksStore(this.store)) {
      return this.readIndex()
    }
    const indexStore = this.store
    if (hasReadMetadataStore(indexStore)) {
      await this.wrapStoreOperation(() => indexStore.readMetadata())
    }
    return hydratedChunkSetToIndex(await this.wrapStoreOperation(() => indexStore.hydrateChunks([id])))
  }

  private async wrapStoreOperation<T>(operation: () => Promise<T>) {
    try {
      return await operation()
    } catch (error) {
      if (!this.recordStoreUnavailable(error)) {
        throw error
      }
      throw new IndexUnavailableError(this.storeError ?? formatThrownError(error))
    }
  }

  private wrapIndexingStore(indexStore: typeof this.store): IndexingStore {
    if (!indexStore) {
      throw new IndexUnavailableError(this.storeError ?? "index unavailable")
    }
    const wrapped: WrappedIndexingStore = {
      read: () => this.wrapStoreOperation(() => indexStore.read()),
      write: (index) => this.wrapStoreOperation(() => indexStore.write(index)),
    }
    addRunStoreMethods(wrapped, indexStore, (operation) => this.wrapStoreOperation(operation))
    if (hasVectorCandidateStore(indexStore)) {
      wrapped.searchVectorCandidates = (queryEmbedding: number[], topK: number, paths?: string[]) =>
        this.wrapStoreOperation(() => indexStore.searchVectorCandidates(queryEmbedding, topK, paths))
    }
    return wrapped
  }

  private retrievalIndexStore(): RetrievalIndexStore {
    if (!this.store) {
      throw new IndexUnavailableError(this.storeError ?? "index unavailable")
    }
    const indexStore = this.store
    const wrapped: RetrievalIndexStore = {
      searchVectorCandidates: (queryEmbedding, topK, paths) => {
        if (!hasVectorCandidateStore(indexStore)) {
          throw new IndexUnavailableError(this.storeError ?? "index unavailable")
        }
        return this.wrapStoreOperation(() => indexStore.searchVectorCandidates(queryEmbedding, topK, paths))
      },
      hydrateChunks: (chunkIds) => {
        if (!hasHydrateChunksStore(indexStore)) {
          throw new IndexUnavailableError(this.storeError ?? "index unavailable")
        }
        return this.wrapStoreOperation(() => indexStore.hydrateChunks(chunkIds))
      },
    }
    if (hasLexicalCandidateStore(indexStore)) {
      wrapped.searchLexicalCandidates = async (query, topK, paths) =>
        this.wrapStoreOperation(() => indexStore.searchLexicalCandidates(query, topK, paths))
    }
    return wrapped
  }

  private generateHydeText(
    query: string,
    signal?: AbortSignal,
    ctx?: Pick<ExtensionContext, "model" | "modelRegistry">,
  ) {
    signal?.throwIfAborted()
    const hyde = this.options.hyde
    if (hyde.mode === "openai-compatible" && hyde.baseURL && hyde.model) {
      return this.client.generateHyde({
        baseURL: hyde.baseURL,
        apiKey: hyde.apiKey,
        model: hyde.model,
        query,
        timeoutMs: hyde.timeoutMs,
        signal,
      })
    }
    if (hyde.mode === "pi-active") {
      return this.generatePiHydeText(query, signal, ctx)
    }
    throw new Error(HYDE_PROVIDER_ERROR)
  }

  private async generatePiHydeText(
    query: string,
    signal?: AbortSignal,
    ctx?: Pick<ExtensionContext, "model" | "modelRegistry">,
  ) {
    if (!ctx?.model) {
      throw new Error(HYDE_PROVIDER_ERROR)
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
    if (!auth.ok) {
      throw new Error(auth.error)
    }
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: query }],
      timestamp: Date.now(),
    }
    const response = await (this.dependencies.complete ?? complete)(
      ctx.model,
      { systemPrompt: HYDE_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: this.options.hyde.timeoutMs },
    )
    if (response.stopReason !== "stop") {
      throw new Error(response.errorMessage ?? `Pi active model HyDE stopped with ${response.stopReason}`)
    }
    return response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
  }
}

function createPiSemsearchExtensionForTest(dependencies: SemsearchRuntimeDependencies = {}) {
  return function semsearchExtension(pi: ExtensionAPI) {
    const runtimes = new Map<string, SemsearchRuntime>()
    const runtimeFor = createRuntimeResolver(runtimes, dependencies)
    registerLifecycle(pi, runtimes, runtimeFor)
    registerRefreshCommand(pi, runtimeFor)
    registerWriteToolIndexHook(pi, runtimeFor)
    registerSearchTool(pi, runtimeFor)
    registerChunkLookupTool(pi, runtimeFor)
  }
}

function createRuntimeResolver(runtimes: Map<string, SemsearchRuntime>, dependencies: SemsearchRuntimeDependencies) {
  return async (ctx: Pick<ExtensionContext, "cwd" | "ui">) => {
    const worktree = path.resolve(ctx.cwd)
    const existing = runtimes.get(worktree)
    if (existing) {
      return existing
    }
    const runtime = new SemsearchRuntime({ worktree, options: await loadPiSemsearchOptions(worktree), dependencies })
    runtimes.set(worktree, runtime)
    await runtime.start()
    return runtime
  }
}

type RuntimeResolver = ReturnType<typeof createRuntimeResolver>

function registerLifecycle(pi: ExtensionAPI, runtimes: Map<string, SemsearchRuntime>, runtimeFor: RuntimeResolver) {
  pi.on("session_start", async (_event, ctx) => {
    const runtime = await runtimeFor(ctx)
    trackIndexingStatus(ctx, runtime, runtime.currentRefresh())
  })

  pi.on("session_shutdown", () => {
    for (const runtime of runtimes.values()) {
      runtime.dispose()
    }
    runtimes.clear()
  })
}

function registerRefreshCommand(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerCommand("semsearch-refresh", {
    description: "Refresh the pi-semsearch code index for the current project",
    handler: async (_args, ctx) => {
      const runtime = await runtimeFor(ctx)
      const refresh = runtime.queueRefresh({ forced: true })
      trackIndexingStatus(ctx, runtime, refresh)
      await refresh
      ctx.ui.notify("pi-semsearch index refreshed", "info")
    },
  })
}

function registerWriteToolIndexHook(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.on("tool_result", async (event, ctx) => {
    if (!isSuccessfulWriteToolResult(event)) {
      return
    }
    const runtime = await runtimeFor(ctx)
    trackIndexingStatus(ctx, runtime, runtime.refreshAfterWrite(event.input.path))
  })
}

function trackIndexingStatus(
  ctx: Pick<ExtensionContext, "ui">,
  runtime: SemsearchRuntime,
  refresh: Promise<unknown> | undefined,
) {
  if (!refresh) {
    return
  }
  ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, SEMSEARCH_INDEXING_STATUS)
  refresh
    .finally(() => {
      if (!runtime.currentRefresh()) {
        ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, undefined)
      }
    })
    .catch(() => undefined)
}

function registerSearchTool(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerTool({
    name: "semantic_search_code",
    label: "Semantic Search Code",
    description: `Find relevant code in the current repository by meaning instead of exact text, symbol, or implementation intent.

Use this as the default first tool for code discovery in this repository, including when the user asks how something works, where behavior, features, APIs, errors, data flow, or relevant code lives, or asks about a known class, function, method, type, test, or feature name. Prefer this before grep/glob/read because it returns ranked, syntax-aware matches with surrounding implementation context and file/line references.

Search results are compact ranked matches by default. Each result includes matched chunk text, scores, breadcrumbs, retrieval details, and topology IDs/labels. Parent body text is returned only when includeParents is true. Use semantic_get_chunk with topology IDs for expanded parent/sibling/child context.

Use grep only when you need exhaustive literal matching, occurrence counts, mechanical text replacement preparation, or matches in files that are not meaningfully represented as code chunks. Use read after this tool returns candidates when you need larger surrounding context or exact verification. Use paths to restrict the search area. Use refresh if files may have changed since the index was built.`,
    promptSnippet: "Find relevant code by semantic meaning with syntax-aware chunks and topology IDs.",
    promptGuidelines: [
      "Use semantic_search_code as the default first tool for code discovery unless exact literal matching is required.",
      "Use semantic_get_chunk with IDs from semantic_search_code when expanded parent, sibling, or child context is needed.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language repository search query." }),
      topK: Type.Optional(Type.Number({ description: "Number of final results. Defaults to 5." })),
      minFinalScore: Type.Optional(Type.Number({ description: "Minimum final retrieval score. Defaults to 0.01." })),
      maxContextChars: Type.Optional(Type.Number({ description: "Context budget. Defaults to 12000." })),
      includeParents: Type.Optional(Type.Boolean({ description: "Include expanded parent body text." })),
      refresh: Type.Optional(Type.Boolean({ description: "Force an index refresh before searching." })),
      paths: Type.Optional(
        Type.Array(Type.String(), { description: "Path filters: exact paths, directory prefixes, or globs." }),
      ),
    }),
    async execute(...args) {
      const [, params, signal, onUpdate, ctx] = args
      const runtime = await runtimeFor(ctx)
      const unavailable = runtime.semanticSearchUnavailable()
      if (unavailable) {
        return piToolResult(unavailable)
      }
      onUpdate?.({ content: [{ type: "text", text: "Searching semantic code index..." }], details: {} })
      try {
        const output = await runtime.semanticSearchOutput(params, signal, ctx)
        return piToolResult(runtime.searchToolResult(params.query, output))
      } catch (error) {
        if (!(error instanceof IndexUnavailableError)) {
          throw error
        }
        return piToolResult(
          unavailableToolResult("Semantic code search index unavailable", INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC),
        )
      }
    },
  })
}

function registerChunkLookupTool(pi: ExtensionAPI, runtimeFor: RuntimeResolver) {
  pi.registerTool({
    name: "semantic_get_chunk",
    label: "Semantic Get Chunk",
    description:
      "Fetch an indexed semantic code chunk by a topology node ID returned from semantic_search_code, with optional parent, sibling, and child topology context.",
    promptSnippet: "Fetch exact semantic chunk context by topology node ID from semantic_search_code.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "A topology node id returned from semantic_search_code, such as topology.current.id, topology.parent.id, a sibling id, or a child id.",
      }),
      includeParents: Type.Optional(Type.Boolean()),
      includeSiblings: Type.Optional(Type.Boolean()),
      includeChildren: Type.Optional(Type.Boolean()),
      childrenOffset: Type.Optional(Type.Number()),
      childrenLimit: Type.Optional(Type.Number()),
      maxContextChars: Type.Optional(Type.Number()),
    }),
    async execute(...args) {
      const [, params, , onUpdate, ctx] = args
      const runtime = await runtimeFor(ctx)
      onUpdate?.({ content: [{ type: "text", text: `Fetching semantic chunk ${params.id}...` }], details: {} })
      return piToolResult(await runtime.lookupChunk(params))
    },
  })
}

const piSemsearchExtension = createPiSemsearchExtensionForTest()

function piToolResult(result: { title: string; output: string; metadata?: unknown }) {
  return {
    content: [{ type: "text" as const, text: `${result.title}\n\n${result.output}` }],
    details: result.metadata && typeof result.metadata === "object" ? result.metadata : { metadata: result.metadata },
  }
}

async function loadPiSemsearchOptions(worktree: string) {
  return parseOptions(await loadConfigFile(worktree))
}

async function loadConfigFile(worktree: string) {
  return (await readFirstConfigCandidate(configCandidates(worktree))) ?? envOptions()
}

function configCandidates(worktree: string) {
  return [
    env.PI_SEMSEARCH_CONFIG,
    path.join(worktree, ".pi", "semsearch.json"),
    path.join(worktree, "semsearch.pi.json"),
    path.join(homedir(), ".pi", "semsearch.json"),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

async function readFirstConfigCandidate(candidates: string[]): Promise<unknown | undefined> {
  const [candidate, ...remaining] = candidates
  if (!candidate) {
    return
  }
  try {
    return JSON.parse(await readFile(candidate, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read pi-semsearch config ${candidate}: ${formatThrownError(error)}`)
    }
    return readFirstConfigCandidate(remaining)
  }
}

function envOptions() {
  return {
    embedding: envEmbeddingOptions(),
    hyde: envHydeOptions(),
    rerank: envRerankOptions(),
  }
}

function envEmbeddingOptions() {
  return {
    baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_EMBEDDING_BASE_URL"),
    apiKeyEnv: env.PI_SEMSEARCH_EMBEDDING_API_KEY_ENV ?? "OPENAI_API_KEY",
    model: env.PI_SEMSEARCH_EMBEDDING_MODEL,
    dimensions: numberEnv("PI_SEMSEARCH_EMBEDDING_DIMENSIONS"),
  }
}

function envHydeOptions() {
  const model = env.PI_SEMSEARCH_HYDE_MODEL
  return model
    ? {
        baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_HYDE_BASE_URL"),
        apiKeyEnv: env.PI_SEMSEARCH_HYDE_API_KEY_ENV ?? "OPENAI_API_KEY",
        model,
        threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD"),
      }
    : { threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD") }
}

function envRerankOptions() {
  const baseUrl = env.PI_SEMSEARCH_RERANK_BASE_URL
  const model = env.PI_SEMSEARCH_RERANK_MODEL
  return baseUrl && model
    ? {
        baseURL: baseUrl,
        apiKeyEnv: env.PI_SEMSEARCH_RERANK_API_KEY_ENV,
        model,
      }
    : undefined
}

function envOpenAiBaseUrl(key: "PI_SEMSEARCH_EMBEDDING_BASE_URL" | "PI_SEMSEARCH_HYDE_BASE_URL") {
  return env[key] ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
}

function numberEnv(key: "PI_SEMSEARCH_EMBEDDING_DIMENSIONS" | "PI_SEMSEARCH_HYDE_THRESHOLD") {
  const value = env[key]
  return value ? Number(value) : undefined
}

function createProjectId(worktree: string) {
  return `pi:${createHash("sha256").update(path.resolve(worktree)).digest("hex")}`
}

function hydratedChunkSetToIndex(hydrated: HydratedChunkSet): CastIndex {
  const index: CastIndex = {
    metadata: hydrated.metadata,
    files: hydrated.files,
    chunks: hydrated.chunks,
    symbols: hydrated.symbols,
  }
  if (hydrated.lexical) {
    index.lexical = hydrated.lexical
  }
  return index
}

function hasVectorCandidateStore(value: unknown): value is VectorCandidateStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "searchVectorCandidates" in value &&
    typeof value.searchVectorCandidates === "function"
  )
}

function hasLexicalCandidateStore(value: unknown): value is LexicalCandidateStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "searchLexicalCandidates" in value &&
    typeof value.searchLexicalCandidates === "function"
  )
}

function hasReadMetadataStore(value: unknown): value is { readMetadata(): Promise<IndexMetadata> } {
  return (
    typeof value === "object" && value !== null && "readMetadata" in value && typeof value.readMetadata === "function"
  )
}

function hasHydrateChunksStore(value: unknown): value is Pick<RetrievalIndexStore, "hydrateChunks"> {
  return (
    typeof value === "object" && value !== null && "hydrateChunks" in value && typeof value.hydrateChunks === "function"
  )
}

function addRunStoreMethods(
  wrapped: WrappedIndexingStore,
  indexStore: NonNullable<ReturnType<typeof createIndexStore>>,
  wrapStoreOperation: <T>(operation: () => Promise<T>) => Promise<T>,
) {
  const maybeRunStore = indexStore as Partial<IndexingStore>
  if (typeof maybeRunStore.beginIndexRun === "function") {
    wrapped.beginIndexRun = (input) =>
      wrapStoreOperation(() => maybeRunStore.beginIndexRun?.(input) as Promise<{ runId: string }>)
  }
  if (typeof maybeRunStore.getCompletedFile === "function") {
    wrapped.getCompletedFile = (runId, filePath, fingerprint) =>
      wrapStoreOperation(
        () =>
          maybeRunStore.getCompletedFile?.(runId, filePath, fingerprint) as ReturnType<
            NonNullable<IndexingStore["getCompletedFile"]>
          >,
      )
  }
  if (typeof maybeRunStore.writeFileResult === "function") {
    wrapped.writeFileResult = (runId, fileResult) =>
      wrapStoreOperation(() => maybeRunStore.writeFileResult?.(runId, fileResult) as Promise<void>)
  }
  if (typeof maybeRunStore.activateRun === "function") {
    wrapped.activateRun = (runId, index) =>
      wrapStoreOperation(() => maybeRunStore.activateRun?.(runId, index) as Promise<void>)
  }
}

function unavailableToolResult(title: string, message: string | undefined) {
  return {
    title,
    output: `index unavailable${message ? `: ${message}` : ""}`,
    metadata: { configured: true, available: false },
  }
}

function searchOutputForTool(output: SearchOutput): SearchOutput {
  const { diagnosticDetails: _outputDetails, ...visibleOutput } = output
  const { diagnosticDetails: _statusDetails, ...visibleStatus } = output.status
  const diagnostics = summarizeDiagnostics({
    diagnostics: [...output.status.diagnostics, ...output.diagnostics],
    details: [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])],
  })
  return {
    ...visibleOutput,
    status: { ...visibleStatus, diagnostics },
    diagnostics,
  }
}

function chunkLookupOutputForTool(output: ChunkLookupOutput): ChunkLookupOutput {
  const { diagnosticDetails: _outputDetails, ...visibleOutput } = output
  const { diagnosticDetails: _statusDetails, ...visibleStatus } = output.status
  const diagnostics = summarizeDiagnostics({
    diagnostics: [...output.status.diagnostics, ...output.diagnostics],
    details: [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])],
  })
  return {
    ...visibleOutput,
    status: { ...visibleStatus, diagnostics },
    diagnostics,
  }
}

function summarizeDiagnostics(input: { diagnostics: string[]; details: DiagnosticRecord[] }) {
  const details = uniqueDiagnosticDetails(input.details)
  const detailMessages = new Set(details.map((detail) => detail.message))
  const indexDiagnostics = details.filter((detail) => detail.code === "index.skipped_file")
  const sourceReadDiagnostics = details.filter((detail) => detail.code === "source.read_failed")
  const sourceMismatchDiagnostics = details.filter((detail) => detail.code === "source.mismatch")
  const grouped = new Set([...indexDiagnostics, ...sourceReadDiagnostics, ...sourceMismatchDiagnostics])
  const detailDiagnostics = details.filter((detail) => !grouped.has(detail)).map((detail) => detail.message)
  const legacyDiagnostics = [...new Set(input.diagnostics.filter((diagnostic) => !detailMessages.has(diagnostic)))]
  const otherDiagnostics = [...detailDiagnostics, ...legacyDiagnostics]
  const summarized: string[] = []

  if (indexDiagnostics.length > 0) {
    summarized.push(`${indexDiagnostics.length} index ${plural(indexDiagnostics.length, "diagnostic")} suppressed`)
  }
  summarized.push(...otherDiagnostics.slice(0, MAX_DIAGNOSTIC_SAMPLES))
  if (otherDiagnostics.length > MAX_DIAGNOSTIC_SAMPLES) {
    const suppressedCount = otherDiagnostics.length - MAX_DIAGNOSTIC_SAMPLES
    summarized.push(`${suppressedCount} additional ${plural(suppressedCount, "diagnostic")} suppressed`)
  }
  if (sourceReadDiagnostics.length > 0) {
    summarized.push(
      `${sourceReadDiagnostics.length} source-read ${plural(
        sourceReadDiagnostics.length,
        "issue",
      )} while hydrating chunks (sample: ${sourceReadDiagnostics[0]?.message})`,
    )
  }
  if (sourceMismatchDiagnostics.length > 0) {
    summarized.push(
      `${sourceMismatchDiagnostics.length} source-mismatch ${plural(
        sourceMismatchDiagnostics.length,
        "issue",
      )} while hydrating chunks (sample: ${sourceMismatchDiagnostics[0]?.message})`,
    )
  }
  return summarized
}

function uniqueDiagnosticDetails(details: DiagnosticRecord[]) {
  const seen = new Set<string>()
  return details.filter((detail) => {
    const key = `${detail.code}\0${detail.message}\0${detail.filePath ?? ""}\0${detail.chunkId ?? ""}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`
}

async function queueInitialRefresh(input: {
  options: ReturnType<typeof parseOptions>
  worktree: string
  store: ReturnType<typeof createIndexStore> | undefined
  queueRefresh: (input: { background?: boolean }) => Promise<unknown>
}) {
  if (!input.options.embedding) {
    return
  }
  if (!hasReadMetadataStore(input.store)) {
    input.queueRefresh({ background: true })
    return
  }
  try {
    const metadata = await input.store.readMetadata()
    if (!canUseReadyIndexForStartup(metadata, input.worktree, input.options)) {
      input.queueRefresh({ background: true })
    }
  } catch {
    input.queueRefresh({ background: true })
  }
}

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

function sameStringArray(left: string[] | undefined, right: string[]) {
  if (!left) {
    return false
  }
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStartupChunking(left: IndexMetadata["chunking"], right: IndexMetadata["chunking"]) {
  return (
    left.overlap === right.overlap &&
    left.expansion === right.expansion &&
    left.minSemanticNonWhitespaceChars === right.minSemanticNonWhitespaceChars
  )
}

async function ensureSearchIndexReady(
  shouldRefresh: boolean,
  queueRefresh: (input?: { forced?: boolean }) => Promise<unknown>,
  currentRefresh: () => Promise<unknown> | undefined,
  currentStoreError: () => string | undefined,
) {
  if (shouldRefresh) {
    await queueRefresh({ forced: true })
  }
  const refreshInProgress = currentRefresh() !== undefined
  if (shouldRefresh) {
    await currentRefresh()
  }
  const storeError = currentStoreError()
  if (storeError) {
    throw new IndexUnavailableError(storeError)
  }
  return { refreshInProgress }
}

function appendSearchDiagnostic(output: SearchOutput, diagnostic: string): SearchOutput {
  return {
    ...output,
    status: {
      ...output.status,
      diagnostics: diagnosticsWithAppendedMessage(output.status.diagnostics, diagnostic),
    },
    diagnostics: diagnosticsWithAppendedMessage(output.diagnostics, diagnostic),
  }
}

function diagnosticsWithAppendedMessage(diagnostics: string[], diagnostic: string) {
  return diagnostics.includes(diagnostic) ? diagnostics : [...diagnostics, diagnostic]
}

function rerankDocuments(input: {
  query: string
  documents: string[]
  rerank: ReturnType<typeof parseOptions>["rerank"]
  client: ReturnType<typeof createOpenAIClient>
  signal?: AbortSignal
}) {
  input.signal?.throwIfAborted()
  return input.rerank
    ? input.client.rerank({
        baseURL: input.rerank.baseURL,
        apiKey: input.rerank.apiKey,
        model: input.rerank.model,
        timeoutMs: input.rerank.timeoutMs,
        query: input.query,
        documents: input.documents,
        signal: input.signal,
      })
    : Promise.reject(new Error("Rerank is not configured"))
}

function serializeToolOutput<T>(input: {
  output: T
  limits: ToolOutputLimits
  compact: (output: T, limits: ToolOutputLimits) => unknown
  minimal: (output: T) => unknown
  diagnosticsFocused: (output: T) => unknown
}) {
  const preferred = serializeJson(input.output)
  if (serializedFits(preferred, input.limits)) {
    return preferred
  }

  const compacted = serializeJson(input.compact(input.output, input.limits))
  if (serializedFits(compacted, input.limits)) {
    return compacted
  }

  const minimalOutput = input.minimal(input.output)
  const serializedMinimal = serializeJson(minimalOutput)
  if (serializedFits(serializedMinimal, input.limits)) {
    return serializedMinimal
  }
  const compactMinimal = JSON.stringify(minimalOutput)
  if (serializedFits(compactMinimal, input.limits)) {
    return compactMinimal
  }

  const diagnosticsOutput = input.diagnosticsFocused(input.output)
  const serializedDiagnostics = serializeJson(diagnosticsOutput)
  if (serializedFits(serializedDiagnostics, input.limits)) {
    return serializedDiagnostics
  }
  const compactDiagnostics = JSON.stringify(diagnosticsOutput)
  return serializedFits(compactDiagnostics, input.limits)
    ? compactDiagnostics
    : forceFitSerialized(compactDiagnostics, input.limits)
}

function serializeJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function serializedFits(serialized: string, limits: ToolOutputLimits) {
  return (
    (limits.maxBytes === undefined || Buffer.byteLength(serialized, "utf8") <= limits.maxBytes) &&
    (limits.maxLines === undefined || serialized.split("\n").length <= limits.maxLines)
  )
}

function forceFitSerialized(serialized: string, limits: ToolOutputLimits) {
  let output = serialized
  if (limits.maxLines !== undefined) {
    output = output.split("\n").slice(0, Math.max(limits.maxLines, 0)).join("\n")
  }
  if (limits.maxBytes !== undefined) {
    output = truncateUtf8(output, Math.max(limits.maxBytes, 0))
  }
  return output
}

function truncateUtf8(value: string, maxBytes: number) {
  let output = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8")
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, -1)
  }
  return output
}

function compactSearchOutput(output: SearchOutput, limits: ToolOutputLimits): SearchOutput {
  for (const maxTextLength of SEARCH_COMPACT_TEXT_LENGTHS) {
    const compacted: SearchOutput = {
      ...output,
      results: output.results.map((result) => {
        const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result
        return { ...rest, text: trimText(text, maxTextLength) }
      }),
      diagnostics: diagnosticsWithSearchCompaction(output.diagnostics),
    }
    if (serializedFits(serializeJson(compacted), limits)) {
      return compacted
    }
  }
  return {
    ...output,
    results: output.results.map((result) => {
      const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result
      return { ...rest, text: trimText(text, 0) }
    }),
    diagnostics: diagnosticsWithSearchCompaction(output.diagnostics),
  }
}

function minimalSearchOutput(output: SearchOutput) {
  return {
    status: output.status,
    results: output.results.map((result, index) => ({
      rank: index + SINGLE_COMPACT_CHILD,
      id: result.topology.current.id,
      label: result.topology.current.label,
      range: result.topology.current.range,
      score: result.score,
      finalScore: result.finalScore,
      retrieval: result.retrieval,
    })),
    ...(output.results.length === 0 ? { diagnostics: diagnosticsWithSearchCompaction(output.diagnostics) } : {}),
  }
}

function diagnosticsFocusedSearchOutput(output: SearchOutput) {
  return {
    status: output.status.status,
    resultCount: output.results.length,
    diagnostics: diagnosticsWithSearchCompaction(output.diagnostics),
  }
}

function compactChunkLookupOutput(output: ChunkLookupOutput, limits: ToolOutputLimits): ChunkLookupOutput {
  for (const maxTextLength of LOOKUP_COMPACT_TEXT_LENGTHS) {
    for (const maxChildren of LOOKUP_COMPACT_CHILD_LIMITS) {
      const compacted = compactChunkLookupOutputWith(output, maxTextLength, maxChildren)
      if (serializedFits(serializeJson(compacted), limits)) {
        return compacted
      }
    }
  }
  return compactChunkLookupOutputWith(output, 0, 0)
}

function compactChunkLookupOutputWith(
  output: ChunkLookupOutput,
  maxTextLength: number,
  maxChildren: number,
): ChunkLookupOutput {
  if (!output.chunk) {
    return { ...output, diagnostics: diagnosticsWithLookupCompaction(output.diagnostics) }
  }

  const { parentText: _parentText, parentRange: _parentRange, text, related, ...chunk } = output.chunk
  const children = related.children.slice(0, maxChildren).map(compactRelatedChunk)
  return {
    ...output,
    chunk: {
      ...chunk,
      text: trimText(text, maxTextLength),
      related: {
        parent: compactRelatedChunk(related.parent),
        previousSibling: compactRelatedChunk(related.previousSibling),
        nextSibling: compactRelatedChunk(related.nextSibling),
        children,
        childrenPage: compactChildrenPage(related.childrenPage, children.length),
      },
    },
    diagnostics: diagnosticsWithLookupCompaction(output.diagnostics),
  }
}

function compactRelatedChunk<T extends { text?: string } | undefined>(chunk: T): T {
  if (!chunk) {
    return chunk
  }
  const { text: _text, ...rest } = chunk
  return rest as T
}

function minimalChunkLookupOutput(output: ChunkLookupOutput) {
  if (!output.chunk) {
    return { status: output.status, diagnostics: diagnosticsWithLookupCompaction(output.diagnostics) }
  }
  return {
    status: output.status,
    chunk: {
      filePath: output.chunk.filePath,
      language: output.chunk.language,
      range: output.chunk.range,
      kind: output.chunk.kind,
      breadcrumbs: output.chunk.breadcrumbs,
      topology: output.chunk.topology,
      related: {
        parent: compactRelatedChunk(output.chunk.related.parent),
        previousSibling: compactRelatedChunk(output.chunk.related.previousSibling),
        nextSibling: compactRelatedChunk(output.chunk.related.nextSibling),
        children: output.chunk.related.children.map(compactRelatedChunk),
        childrenPage: output.chunk.related.childrenPage,
      },
    },
    diagnostics: diagnosticsWithLookupCompaction(output.diagnostics),
  }
}

function diagnosticsFocusedChunkLookupOutput(output: ChunkLookupOutput) {
  return {
    status: output.status.status,
    found: Boolean(output.chunk),
    diagnostics: diagnosticsWithLookupCompaction(output.diagnostics),
  }
}

function compactChildrenPage(
  page: NonNullable<ChunkLookupOutput["chunk"]>["related"]["childrenPage"],
  emittedChildren: number,
) {
  if (emittedChildren === page.limit) {
    return page
  }
  return {
    ...page,
    limit: emittedChildren,
    hasMore: page.offset + emittedChildren < page.total,
  }
}

function diagnosticsWithSearchCompaction(diagnostics: string[]) {
  return diagnostics.includes(COMPACTION_DIAGNOSTIC) ? diagnostics : [...diagnostics, COMPACTION_DIAGNOSTIC]
}

function diagnosticsWithLookupCompaction(diagnostics: string[]) {
  return diagnostics.includes(LOOKUP_COMPACTION_DIAGNOSTIC)
    ? diagnostics
    : [...diagnostics, LOOKUP_COMPACTION_DIAGNOSTIC]
}

function trimText(text: string, maxLength: number) {
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function isStoreUnavailableError(error: unknown) {
  const message = formatThrownError(error).toLowerCase()
  return (
    message.includes("sqlite") ||
    message.includes("database") ||
    message.includes("index unavailable") ||
    message.includes("failed to open") ||
    message.includes("unable to open")
  )
}

function formatThrownError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isSuccessfulWriteToolResult(event: { toolName?: unknown; input?: unknown; isError?: unknown }): event is {
  toolName: "write"
  input: { path: string }
  isError?: false
} {
  return (
    event.toolName === "write" &&
    event.isError !== true &&
    typeof event.input === "object" &&
    event.input !== null &&
    "path" in event.input &&
    typeof event.input.path === "string"
  )
}

function isWorktreePath(worktree: string, filePath: string) {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, filePath)
  const relative = path.relative(root, resolved)
  return !(relative.startsWith("..") || path.isAbsolute(relative))
}

async function resolveWorktreePath(worktree: string, filePath: string) {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, filePath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`source path escapes worktree: ${filePath}`)
  }
  const realRoot = await realpath(root)
  const realResolved = await realpath(resolved)
  const realRelative = path.relative(realRoot, realResolved)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`source path escapes worktree: ${filePath}`)
  }
  return resolved
}

export type { SemsearchRuntimeDependencies }
export { createPiSemsearchExtensionForTest, piSemsearchExtension }
