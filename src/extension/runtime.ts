import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { complete, type UserMessage } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { HYDE_SYSTEM_PROMPT } from "../embeddings/hyde.js"
import { createOpenAIClient, type FetchLike } from "../embeddings/openai.js"
import type { parseOptions } from "../options/index.js"
import { parseSource } from "../parsing/language.js"
import { getChunkById } from "../retriever/chunk-lookup.js"
import { type RetrievalIndexStore, retrieveFromStore } from "../retriever/index.js"
import { createIndexer } from "../scanner/index.js"
import type { SearchOutput } from "../shared/types.js"
import { createIndexStore } from "../store/index.js"
import { formatThrownError, IndexUnavailableError, isStoreUnavailableError } from "./errors.js"
import {
  appendSearchDiagnostic,
  ensureSearchIndexReady,
  INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC,
  queueInitialRefresh,
  rerankDocuments,
} from "./index-ready.js"
import type { ToolOutputLimits } from "./output.js"
import { serializeChunkLookupToolOutput, serializeSearchToolOutput, unavailableToolResult } from "./output.js"
import { resolveWorktreePath, worktreeRelativePath } from "./paths.js"
import type { IndexingStore, WrappedIndexingStore } from "./store.js"
import {
  addRunStoreMethods,
  createProjectId,
  hasHydrateChunksStore,
  hasLexicalCandidateStore,
  hasReadMetadataStore,
  hasVectorCandidateStore,
  hydratedChunkSetToIndex,
} from "./store.js"

const HYDE_PROVIDER_ERROR =
  "pi-semsearch HyDE requires either an active Pi model or explicit hyde.baseURL and hyde.model; set hyde.enabled=false to disable HyDE"

interface RuntimeDependencies {
  fetch?: FetchLike
  createStore?: typeof createIndexStore
  createIndexer?: typeof createIndexer
  retrieve?: typeof retrieveFromStore
  complete?: typeof complete
}

class SemsearchRuntime {
  private readonly client: ReturnType<typeof createOpenAIClient>
  private readonly lifecycle = new AbortController()
  private readonly worktree: string
  private readonly options: ReturnType<typeof parseOptions>
  private readonly dependencies: RuntimeDependencies
  private readonly store: ReturnType<typeof createIndexStore> | undefined
  private storeError: string | undefined
  private refresh: Promise<unknown> | undefined
  private forcedRefresh: Promise<unknown> | undefined
  private refreshTail = Promise.resolve()

  constructor(input: {
    worktree: string
    options: ReturnType<typeof parseOptions>
    dependencies?: RuntimeDependencies
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

  queueRefresh(refreshInput: { background?: boolean; forced?: boolean; filePath?: string } = {}) {
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
        const indexer = (this.dependencies.createIndexer ?? createIndexer)({
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
        })
        return refreshInput.filePath
          ? indexer.refreshFile(refreshInput.filePath, this.lifecycle.signal)
          : indexer.refresh(this.lifecycle.signal)
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
    return {
      title: `Semantic chunk lookup: ${args.id}`,
      output: serializeChunkLookupToolOutput(output),
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
    return {
      title: `Semantic code search: ${query}`,
      output: serializeSearchToolOutput(output, limits),
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
    const relativePath = worktreeRelativePath(this.worktree, filePath)
    if (this.semanticSearchUnavailable() || !relativePath) {
      return
    }
    return this.queueRefresh({ background: true, filePath: relativePath })
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

export type { RuntimeDependencies }
export { SemsearchRuntime }
