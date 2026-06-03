import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { env } from "node:process";
import { complete } from "@earendil-works/pi-ai";
import { Minimatch } from "minimatch";
import { Type } from "typebox";
import { getChunkById } from "./chunk-lookup.js";
import { HYDE_SYSTEM_PROMPT } from "./hyde.js";
import { parseSource } from "./language.js";
import { createOpenAIClient } from "./openai.js";
import { parseOptions } from "./options.js";
import { retrieveFromStore } from "./retriever.js";
import { createIndexer } from "./scanner.js";
import { createIndexStore } from "./store.js";
const SEMSEARCH_STATUS_KEY = "semsearch";
const SEMSEARCH_INDEXING_STATUS = "pi-semsearch indexing";
const COMPACTION_DIAGNOSTIC = "output compacted; use semantic_get_chunk for more context";
const INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; results may be stale";
const INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; no searchable active index is available yet";
const LOOKUP_COMPACTION_DIAGNOSTIC = "output compacted; narrow semantic_get_chunk args, page children, or reduce included relations";
const HYDE_PROVIDER_ERROR = "pi-semsearch HyDE requires either an active Pi model or explicit hyde.baseURL and hyde.model; set hyde.enabled=false to disable HyDE";
const LONG_COMPACT_TEXT_LENGTH = 200;
const MEDIUM_COMPACT_TEXT_LENGTH = 80;
const SHORT_COMPACT_TEXT_LENGTH = 20;
const OMITTED_TEXT_LENGTH = 0;
const MANY_COMPACT_CHILDREN = 5;
const SINGLE_COMPACT_CHILD = 1;
const MAX_DIAGNOSTIC_SAMPLES = 5;
const NO_COMPACT_CHILDREN = 0;
const SEARCH_COMPACT_TEXT_LENGTHS = [
    LONG_COMPACT_TEXT_LENGTH,
    MEDIUM_COMPACT_TEXT_LENGTH,
    SHORT_COMPACT_TEXT_LENGTH,
    OMITTED_TEXT_LENGTH,
];
const LOOKUP_COMPACT_TEXT_LENGTHS = [LONG_COMPACT_TEXT_LENGTH, MEDIUM_COMPACT_TEXT_LENGTH, OMITTED_TEXT_LENGTH];
const LOOKUP_COMPACT_CHILD_LIMITS = [
    Number.MAX_SAFE_INTEGER,
    MANY_COMPACT_CHILDREN,
    SINGLE_COMPACT_CHILD,
    NO_COMPACT_CHILDREN,
];
class IndexUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "IndexUnavailableError";
    }
}
class SemsearchRuntime {
    client;
    lifecycle = new AbortController();
    worktree;
    options;
    dependencies;
    store;
    storeError;
    refresh;
    forcedRefresh;
    refreshTail = Promise.resolve();
    constructor(input) {
        this.worktree = input.worktree;
        this.options = input.options;
        this.dependencies = input.dependencies ?? {};
        this.client = createOpenAIClient(this.dependencies.fetch ? { fetch: this.dependencies.fetch } : {});
        try {
            this.store = (this.dependencies.createStore ?? createIndexStore)({
                cacheDir: this.options.cacheDir,
                cacheKey: createHash("sha256")
                    .update(JSON.stringify({
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
                }))
                    .digest("hex"),
                embeddingDimensions: this.options.embedding?.dimensions,
            });
        }
        catch (error) {
            this.storeError = formatThrownError(error);
        }
    }
    async start() {
        await queueInitialRefresh({
            options: this.options,
            worktree: this.worktree,
            store: this.store,
            queueRefresh: (input) => this.queueRefresh(input),
        });
    }
    dispose() {
        this.lifecycle.abort();
        this.refresh = undefined;
        this.forcedRefresh = undefined;
        this.refreshTail = Promise.resolve();
    }
    queueRefresh(refreshInput = {}) {
        const embedding = this.options.embedding;
        if (!(embedding && this.store) || this.storeError) {
            return Promise.resolve();
        }
        if (refreshInput.forced && this.forcedRefresh) {
            return this.forcedRefresh;
        }
        const indexStore = this.store;
        const nextRefresh = this.refreshTail
            .then(() => {
            this.lifecycle.signal.throwIfAborted();
            if (this.storeError) {
                return;
            }
            const indexingStore = this.wrapIndexingStore(indexStore);
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
            });
            return refreshInput.filePath
                ? indexer.refreshFile(refreshInput.filePath, this.lifecycle.signal)
                : indexer.refresh(this.lifecycle.signal);
        })
            .catch((error) => {
            if (error instanceof IndexUnavailableError) {
                this.storeError = error.message;
                return;
            }
            if (!refreshInput.background) {
                throw error;
            }
        });
        this.refresh = nextRefresh;
        if (refreshInput.forced) {
            this.forcedRefresh = nextRefresh;
        }
        nextRefresh.then(() => this.clearRefresh(nextRefresh), () => this.clearRefresh(nextRefresh));
        this.refreshTail = nextRefresh.then(() => undefined, () => undefined);
        return nextRefresh;
    }
    async semanticSearchOutput(args, signal, ctx) {
        const embedding = this.options.embedding;
        if (!embedding) {
            throw new Error("embedding dependency unavailable");
        }
        const readiness = await ensureSearchIndexReady(args.refresh === true, (input) => this.queueRefresh(input), () => this.refresh, () => this.storeError);
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
                rerank: (query, documents) => rerankDocuments({ query, documents, rerank: this.options.rerank, client: this.client, signal }),
                readSource: async (filePath) => readFile(await resolveWorktreePath(this.worktree, filePath), "utf8"),
                indexStore: this.retrievalIndexStore(),
            });
            return readiness.refreshInProgress ? appendSearchDiagnostic(output, INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC) : output;
        }
        catch (error) {
            if (!(error instanceof IndexUnavailableError)) {
                throw error;
            }
            throw new IndexUnavailableError(this.storeError ?? formatThrownError(error));
        }
    }
    async lookupChunk(args) {
        if (!this.options.embedding) {
            return {
                title: "Semantic chunk lookup is not configured",
                output: this.options.diagnostics.join("\n"),
                metadata: { configured: false },
            };
        }
        if (!this.store) {
            return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError);
        }
        await this.refresh;
        if (this.storeError) {
            return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError);
        }
        let output;
        try {
            output = await getChunkById({
                index: await this.readChunkLookupIndex(args.id),
                input: args,
                readSource: async (filePath) => readFile(await resolveWorktreePath(this.worktree, filePath), "utf8"),
            });
        }
        catch (error) {
            if (!(error instanceof IndexUnavailableError)) {
                throw error;
            }
            return unavailableToolResult("Semantic chunk lookup index unavailable", this.storeError);
        }
        const toolOutput = chunkLookupOutputForTool(output);
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
        };
    }
    semanticSearchUnavailable() {
        if (!this.options.embedding) {
            return {
                title: "Semantic code search is not configured",
                output: this.options.diagnostics.join("\n"),
                metadata: { configured: false },
            };
        }
        return this.store ? undefined : unavailableToolResult("Semantic code search index unavailable", this.storeError);
    }
    searchToolResult(query, output, limits = {}) {
        const toolOutput = searchOutputForTool(output);
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
        };
    }
    refreshAfterWrite(filePath) {
        const relativePath = worktreeRelativePath(this.worktree, filePath);
        if (this.semanticSearchUnavailable() || !relativePath) {
            return;
        }
        return this.queueRefresh({ background: true, filePath: relativePath });
    }
    currentRefresh() {
        return this.refresh;
    }
    clearRefresh(refresh) {
        if (this.refresh === refresh) {
            this.refresh = undefined;
        }
        if (this.forcedRefresh === refresh) {
            this.forcedRefresh = undefined;
        }
    }
    recordStoreUnavailable(error) {
        if (!isStoreUnavailableError(error)) {
            return false;
        }
        this.storeError = formatThrownError(error);
        return true;
    }
    async readIndex() {
        if (!this.store) {
            throw new Error(this.storeError ?? "index unavailable");
        }
        try {
            return await this.store.read();
        }
        catch (error) {
            if (!this.recordStoreUnavailable(error)) {
                throw error;
            }
            throw new IndexUnavailableError(this.storeError ?? formatThrownError(error));
        }
    }
    async readChunkLookupIndex(id) {
        if (!this.store) {
            throw new Error(this.storeError ?? "index unavailable");
        }
        if (!hasHydrateChunksStore(this.store)) {
            return this.readIndex();
        }
        const indexStore = this.store;
        if (hasReadMetadataStore(indexStore)) {
            await this.wrapStoreOperation(() => indexStore.readMetadata());
        }
        return hydratedChunkSetToIndex(await this.wrapStoreOperation(() => indexStore.hydrateChunks([id])));
    }
    async wrapStoreOperation(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (!this.recordStoreUnavailable(error)) {
                throw error;
            }
            throw new IndexUnavailableError(this.storeError ?? formatThrownError(error));
        }
    }
    wrapIndexingStore(indexStore) {
        if (!indexStore) {
            throw new IndexUnavailableError(this.storeError ?? "index unavailable");
        }
        const wrapped = {
            read: () => this.wrapStoreOperation(() => indexStore.read()),
            write: (index) => this.wrapStoreOperation(() => indexStore.write(index)),
        };
        addRunStoreMethods(wrapped, indexStore, (operation) => this.wrapStoreOperation(operation));
        if (hasVectorCandidateStore(indexStore)) {
            wrapped.searchVectorCandidates = (queryEmbedding, topK, paths) => this.wrapStoreOperation(() => indexStore.searchVectorCandidates(queryEmbedding, topK, paths));
        }
        return wrapped;
    }
    retrievalIndexStore() {
        if (!this.store) {
            throw new IndexUnavailableError(this.storeError ?? "index unavailable");
        }
        const indexStore = this.store;
        const wrapped = {
            searchVectorCandidates: (queryEmbedding, topK, paths) => {
                if (!hasVectorCandidateStore(indexStore)) {
                    throw new IndexUnavailableError(this.storeError ?? "index unavailable");
                }
                return this.wrapStoreOperation(() => indexStore.searchVectorCandidates(queryEmbedding, topK, paths));
            },
            hydrateChunks: (chunkIds) => {
                if (!hasHydrateChunksStore(indexStore)) {
                    throw new IndexUnavailableError(this.storeError ?? "index unavailable");
                }
                return this.wrapStoreOperation(() => indexStore.hydrateChunks(chunkIds));
            },
        };
        if (hasLexicalCandidateStore(indexStore)) {
            wrapped.searchLexicalCandidates = async (query, topK, paths) => this.wrapStoreOperation(() => indexStore.searchLexicalCandidates(query, topK, paths));
        }
        return wrapped;
    }
    generateHydeText(query, signal, ctx) {
        signal?.throwIfAborted();
        const hyde = this.options.hyde;
        if (hyde.mode === "openai-compatible" && hyde.baseURL && hyde.model) {
            return this.client.generateHyde({
                baseURL: hyde.baseURL,
                apiKey: hyde.apiKey,
                model: hyde.model,
                query,
                timeoutMs: hyde.timeoutMs,
                signal,
            });
        }
        if (hyde.mode === "pi-active") {
            return this.generatePiHydeText(query, signal, ctx);
        }
        throw new Error(HYDE_PROVIDER_ERROR);
    }
    async generatePiHydeText(query, signal, ctx) {
        if (!ctx?.model) {
            throw new Error(HYDE_PROVIDER_ERROR);
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok) {
            throw new Error(auth.error);
        }
        const userMessage = {
            role: "user",
            content: [{ type: "text", text: query }],
            timestamp: Date.now(),
        };
        const response = await (this.dependencies.complete ?? complete)(ctx.model, { systemPrompt: HYDE_SYSTEM_PROMPT, messages: [userMessage] }, { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: this.options.hyde.timeoutMs });
        if (response.stopReason !== "stop") {
            throw new Error(response.errorMessage ?? `Pi active model HyDE stopped with ${response.stopReason}`);
        }
        return response.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
    }
}
function createPiSemsearchExtensionForTest(dependencies = {}) {
    return function semsearchExtension(pi) {
        const runtimes = new Map();
        const runtimeFor = createRuntimeResolver(runtimes, dependencies);
        registerLifecycle(pi, runtimes, runtimeFor);
        registerRefreshCommand(pi, runtimeFor);
        registerWriteToolIndexHook(pi, runtimeFor);
        registerSearchTool(pi, runtimeFor);
        registerChunkLookupTool(pi, runtimeFor);
    };
}
function createRuntimeResolver(runtimes, dependencies) {
    return async (ctx) => {
        const worktree = path.resolve(ctx.cwd);
        const existing = runtimes.get(worktree);
        if (existing) {
            return existing;
        }
        const runtime = new SemsearchRuntime({ worktree, options: await loadPiSemsearchOptions(worktree), dependencies });
        runtimes.set(worktree, runtime);
        await runtime.start();
        return runtime;
    };
}
function registerLifecycle(pi, runtimes, runtimeFor) {
    pi.on("session_start", async (_event, ctx) => {
        const runtime = await runtimeFor(ctx);
        trackIndexingStatus(ctx, runtime, runtime.currentRefresh());
    });
    pi.on("session_shutdown", () => {
        for (const runtime of runtimes.values()) {
            runtime.dispose();
        }
        runtimes.clear();
    });
}
function registerRefreshCommand(pi, runtimeFor) {
    pi.registerCommand("semsearch-refresh", {
        description: "Refresh the pi-semsearch code index for the current project",
        handler: async (_args, ctx) => {
            const runtime = await runtimeFor(ctx);
            const refresh = runtime.queueRefresh({ forced: true });
            trackIndexingStatus(ctx, runtime, refresh);
            await refresh;
            ctx.ui.notify("pi-semsearch index refreshed", "info");
        },
    });
}
function registerWriteToolIndexHook(pi, runtimeFor) {
    pi.on("tool_result", async (event, ctx) => {
        if (!isSuccessfulWriteToolResult(event)) {
            return;
        }
        const runtime = await runtimeFor(ctx);
        trackIndexingStatus(ctx, runtime, runtime.refreshAfterWrite(event.input.path));
    });
}
function trackIndexingStatus(ctx, runtime, refresh) {
    if (!refresh) {
        return;
    }
    ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, SEMSEARCH_INDEXING_STATUS);
    refresh
        .finally(() => {
        if (!runtime.currentRefresh()) {
            ctx.ui.setStatus(SEMSEARCH_STATUS_KEY, undefined);
        }
    })
        .catch(() => undefined);
}
function registerSearchTool(pi, runtimeFor) {
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
            paths: Type.Optional(Type.Array(Type.String(), { description: "Path filters: exact paths, directory prefixes, or globs." })),
        }),
        async execute(...args) {
            const [, params, signal, onUpdate, ctx] = args;
            const runtime = await runtimeFor(ctx);
            const unavailable = runtime.semanticSearchUnavailable();
            if (unavailable) {
                return piToolResult(unavailable);
            }
            onUpdate?.({ content: [{ type: "text", text: "Searching semantic code index..." }], details: {} });
            try {
                const output = await runtime.semanticSearchOutput(params, signal, ctx);
                return piToolResult(runtime.searchToolResult(params.query, output));
            }
            catch (error) {
                if (!(error instanceof IndexUnavailableError)) {
                    throw error;
                }
                return piToolResult(unavailableToolResult("Semantic code search index unavailable", INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC));
            }
        },
    });
}
function registerChunkLookupTool(pi, runtimeFor) {
    pi.registerTool({
        name: "semantic_get_chunk",
        label: "Semantic Get Chunk",
        description: "Fetch an indexed semantic code chunk by a topology node ID returned from semantic_search_code, with optional parent, sibling, and child topology context.",
        promptSnippet: "Fetch exact semantic chunk context by topology node ID from semantic_search_code.",
        parameters: Type.Object({
            id: Type.String({
                description: "A topology node id returned from semantic_search_code, such as topology.current.id, topology.parent.id, a sibling id, or a child id.",
            }),
            includeParents: Type.Optional(Type.Boolean()),
            includeSiblings: Type.Optional(Type.Boolean()),
            includeChildren: Type.Optional(Type.Boolean()),
            childrenOffset: Type.Optional(Type.Number()),
            childrenLimit: Type.Optional(Type.Number()),
            maxContextChars: Type.Optional(Type.Number()),
        }),
        async execute(...args) {
            const [, params, , onUpdate, ctx] = args;
            const runtime = await runtimeFor(ctx);
            onUpdate?.({ content: [{ type: "text", text: `Fetching semantic chunk ${params.id}...` }], details: {} });
            return piToolResult(await runtime.lookupChunk(params));
        },
    });
}
const piSemsearchExtension = createPiSemsearchExtensionForTest();
function piToolResult(result) {
    return {
        content: [{ type: "text", text: `${result.title}\n\n${result.output}` }],
        details: result.metadata && typeof result.metadata === "object" ? result.metadata : { metadata: result.metadata },
    };
}
async function loadPiSemsearchOptions(worktree) {
    return parseOptions(await loadConfigFile(worktree));
}
async function loadConfigFile(worktree) {
    return (await readFirstConfigCandidate(configCandidates(worktree))) ?? envOptions();
}
function configCandidates(worktree) {
    return [
        env.PI_SEMSEARCH_CONFIG,
        path.join(worktree, ".pi", "semsearch.json"),
        path.join(worktree, "semsearch.pi.json"),
        path.join(homedir(), ".pi", "semsearch.json"),
    ].filter((candidate) => Boolean(candidate));
}
async function readFirstConfigCandidate(candidates) {
    const [candidate, ...remaining] = candidates;
    if (!candidate) {
        return;
    }
    try {
        return JSON.parse(await readFile(candidate, "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw new Error(`Failed to read pi-semsearch config ${candidate}: ${formatThrownError(error)}`);
        }
        return readFirstConfigCandidate(remaining);
    }
}
function envOptions() {
    return {
        embedding: envEmbeddingOptions(),
        hyde: envHydeOptions(),
        rerank: envRerankOptions(),
    };
}
function envEmbeddingOptions() {
    return {
        baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_EMBEDDING_BASE_URL"),
        apiKeyEnv: env.PI_SEMSEARCH_EMBEDDING_API_KEY_ENV ?? "OPENAI_API_KEY",
        model: env.PI_SEMSEARCH_EMBEDDING_MODEL,
        dimensions: numberEnv("PI_SEMSEARCH_EMBEDDING_DIMENSIONS"),
    };
}
function envHydeOptions() {
    const model = env.PI_SEMSEARCH_HYDE_MODEL;
    return model
        ? {
            baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_HYDE_BASE_URL"),
            apiKeyEnv: env.PI_SEMSEARCH_HYDE_API_KEY_ENV ?? "OPENAI_API_KEY",
            model,
            threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD"),
        }
        : { threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD") };
}
function envRerankOptions() {
    const baseUrl = env.PI_SEMSEARCH_RERANK_BASE_URL;
    const model = env.PI_SEMSEARCH_RERANK_MODEL;
    return baseUrl && model
        ? {
            baseURL: baseUrl,
            apiKeyEnv: env.PI_SEMSEARCH_RERANK_API_KEY_ENV,
            model,
        }
        : undefined;
}
function envOpenAiBaseUrl(key) {
    return env[key] ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}
function numberEnv(key) {
    const value = env[key];
    return value ? Number(value) : undefined;
}
function createProjectId(worktree) {
    return `pi:${createHash("sha256").update(path.resolve(worktree)).digest("hex")}`;
}
function hydratedChunkSetToIndex(hydrated) {
    const index = {
        metadata: hydrated.metadata,
        files: hydrated.files,
        chunks: hydrated.chunks,
        symbols: hydrated.symbols,
    };
    if (hydrated.lexical) {
        index.lexical = hydrated.lexical;
    }
    return index;
}
function hasVectorCandidateStore(value) {
    return (typeof value === "object" &&
        value !== null &&
        "searchVectorCandidates" in value &&
        typeof value.searchVectorCandidates === "function");
}
function hasLexicalCandidateStore(value) {
    return (typeof value === "object" &&
        value !== null &&
        "searchLexicalCandidates" in value &&
        typeof value.searchLexicalCandidates === "function");
}
function hasReadMetadataStore(value) {
    return (typeof value === "object" && value !== null && "readMetadata" in value && typeof value.readMetadata === "function");
}
function hasHydrateChunksStore(value) {
    return (typeof value === "object" && value !== null && "hydrateChunks" in value && typeof value.hydrateChunks === "function");
}
function addRunStoreMethods(wrapped, indexStore, wrapStoreOperation) {
    const maybeRunStore = indexStore;
    if (typeof maybeRunStore.beginIndexRun === "function") {
        wrapped.beginIndexRun = (input) => wrapStoreOperation(() => maybeRunStore.beginIndexRun?.(input));
    }
    if (typeof maybeRunStore.getCompletedFile === "function") {
        wrapped.getCompletedFile = (runId, filePath, fingerprint) => wrapStoreOperation(() => maybeRunStore.getCompletedFile?.(runId, filePath, fingerprint));
    }
    if (typeof maybeRunStore.writeFileResult === "function") {
        wrapped.writeFileResult = (runId, fileResult) => wrapStoreOperation(() => maybeRunStore.writeFileResult?.(runId, fileResult));
    }
    if (typeof maybeRunStore.activateRun === "function") {
        wrapped.activateRun = (runId, index) => wrapStoreOperation(() => maybeRunStore.activateRun?.(runId, index));
    }
}
function unavailableToolResult(title, message) {
    return {
        title,
        output: `index unavailable${message ? `: ${message}` : ""}`,
        metadata: { configured: true, available: false },
    };
}
function searchOutputForTool(output) {
    const diagnosticDetails = [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])];
    const diagnostics = summarizeDiagnostics({
        diagnostics: [...output.status.diagnostics, ...output.diagnostics],
        details: diagnosticDetails,
    });
    return {
        results: output.results,
        status: visibleStatusForTool(output.status, diagnostics, [
            ...output.results.map((result) => result.filePath),
            ...diagnosticFilePaths(diagnosticDetails),
        ]),
    };
}
function chunkLookupOutputForTool(output) {
    const diagnosticDetails = [...(output.status.diagnosticDetails ?? []), ...(output.diagnosticDetails ?? [])];
    const diagnostics = summarizeDiagnostics({
        diagnostics: [...output.status.diagnostics, ...output.diagnostics],
        details: diagnosticDetails,
    });
    return {
        ...(output.chunk ? { chunk: output.chunk } : {}),
        status: visibleStatusForTool(output.status, diagnostics, [
            ...(output.chunk ? [output.chunk.filePath] : []),
            ...diagnosticFilePaths(diagnosticDetails),
        ]),
    };
}
function visibleStatusForTool(status, diagnostics, relevantPaths) {
    const { projectId: _projectId, cacheKey: _cacheKey, includeGlobs, excludeGlobs, diagnosticDetails: _diagnosticDetails, diagnostics: _diagnostics, ...visibleStatus } = status;
    return {
        ...visibleStatus,
        ...matchedVisibleGlobs({ includeGlobs, excludeGlobs, relevantPaths }),
        diagnostics,
    };
}
function matchedVisibleGlobs(input) {
    const relevantPaths = [...new Set(input.relevantPaths.filter((filePath) => filePath.length > 0))];
    if (relevantPaths.length === 0) {
        return {};
    }
    const includeGlobs = matchedGlobs(input.includeGlobs ?? [], relevantPaths).filter((glob) => glob !== "**/*");
    const excludeGlobs = matchedGlobs(input.excludeGlobs ?? [], relevantPaths);
    return {
        ...(includeGlobs.length > 0 ? { includeGlobs } : {}),
        ...(excludeGlobs.length > 0 ? { excludeGlobs } : {}),
    };
}
function matchedGlobs(globs, relevantPaths) {
    return globs.filter((glob) => {
        const matcher = new Minimatch(glob, { dot: true });
        return relevantPaths.some((filePath) => matcher.match(toGlobPath(filePath)));
    });
}
function toGlobPath(filePath) {
    return filePath.split(path.sep).join("/");
}
function diagnosticFilePaths(details) {
    return details.flatMap((detail) => (detail.filePath ? [detail.filePath] : []));
}
function summarizeDiagnostics(input) {
    const details = uniqueDiagnosticDetails(input.details);
    const detailMessages = new Set(details.map((detail) => detail.message));
    const indexDiagnostics = details.filter((detail) => detail.code === "index.skipped_file");
    const sourceReadDiagnostics = details.filter((detail) => detail.code === "source.read_failed");
    const sourceMismatchDiagnostics = details.filter((detail) => detail.code === "source.mismatch");
    const grouped = new Set([...indexDiagnostics, ...sourceReadDiagnostics, ...sourceMismatchDiagnostics]);
    const detailDiagnostics = details.filter((detail) => !grouped.has(detail)).map((detail) => detail.message);
    const legacyDiagnostics = [...new Set(input.diagnostics.filter((diagnostic) => !detailMessages.has(diagnostic)))];
    const otherDiagnostics = [...detailDiagnostics, ...legacyDiagnostics];
    const summarized = [];
    if (indexDiagnostics.length > 0) {
        summarized.push(`${indexDiagnostics.length} index ${plural(indexDiagnostics.length, "diagnostic")} suppressed`);
    }
    summarized.push(...otherDiagnostics.slice(0, MAX_DIAGNOSTIC_SAMPLES));
    if (otherDiagnostics.length > MAX_DIAGNOSTIC_SAMPLES) {
        const suppressedCount = otherDiagnostics.length - MAX_DIAGNOSTIC_SAMPLES;
        summarized.push(`${suppressedCount} additional ${plural(suppressedCount, "diagnostic")} suppressed`);
    }
    if (sourceReadDiagnostics.length > 0) {
        summarized.push(`${sourceReadDiagnostics.length} source-read ${plural(sourceReadDiagnostics.length, "issue")} while hydrating chunks (sample: ${sourceReadDiagnostics[0]?.message})`);
    }
    if (sourceMismatchDiagnostics.length > 0) {
        summarized.push(`${sourceMismatchDiagnostics.length} source-mismatch ${plural(sourceMismatchDiagnostics.length, "issue")} while hydrating chunks (sample: ${sourceMismatchDiagnostics[0]?.message})`);
    }
    return summarized;
}
function uniqueDiagnosticDetails(details) {
    const seen = new Set();
    return details.filter((detail) => {
        const key = `${detail.code}\0${detail.message}\0${detail.filePath ?? ""}\0${detail.chunkId ?? ""}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function plural(count, word) {
    return count === 1 ? word : `${word}s`;
}
async function queueInitialRefresh(input) {
    if (!input.options.embedding) {
        return;
    }
    if (!hasReadMetadataStore(input.store)) {
        input.queueRefresh({ background: true });
        return;
    }
    try {
        const metadata = await input.store.readMetadata();
        if (!canUseReadyIndexForStartup(metadata, input.worktree, input.options)) {
            input.queueRefresh({ background: true });
        }
    }
    catch {
        input.queueRefresh({ background: true });
    }
}
function canUseReadyIndexForStartup(metadata, worktree, options) {
    return (metadata.status === "ready" &&
        metadata.worktree === worktree &&
        metadata.maxFileBytes === options.maxFileBytes &&
        sameStringArray(metadata.includeGlobs, options.includeGlobs) &&
        sameStringArray(metadata.excludeGlobs, options.excludeGlobs) &&
        metadata.maxChunkNonWhitespaceChars === options.maxChunkNonWhitespaceChars &&
        sameStartupChunking(metadata.chunking, options.chunking));
}
function sameStringArray(left, right) {
    if (!left) {
        return false;
    }
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameStartupChunking(left, right) {
    return (left.overlap === right.overlap &&
        left.expansion === right.expansion &&
        left.minSemanticNonWhitespaceChars === right.minSemanticNonWhitespaceChars);
}
async function ensureSearchIndexReady(shouldRefresh, queueRefresh, currentRefresh, currentStoreError) {
    if (shouldRefresh) {
        await queueRefresh({ forced: true });
    }
    const refreshInProgress = currentRefresh() !== undefined;
    if (shouldRefresh) {
        await currentRefresh();
    }
    const storeError = currentStoreError();
    if (storeError) {
        throw new IndexUnavailableError(storeError);
    }
    return { refreshInProgress };
}
function appendSearchDiagnostic(output, diagnostic) {
    return {
        ...output,
        status: {
            ...output.status,
            diagnostics: diagnosticsWithAppendedMessage(output.status.diagnostics, diagnostic),
        },
        diagnostics: diagnosticsWithAppendedMessage(output.diagnostics, diagnostic),
    };
}
function diagnosticsWithAppendedMessage(diagnostics, diagnostic) {
    return diagnostics.includes(diagnostic) ? diagnostics : [...diagnostics, diagnostic];
}
function rerankDocuments(input) {
    input.signal?.throwIfAborted();
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
        : Promise.reject(new Error("Rerank is not configured"));
}
function serializeToolOutput(input) {
    const preferred = serializeJson(input.output);
    if (serializedFits(preferred, input.limits)) {
        return preferred;
    }
    const compacted = serializeJson(input.compact(input.output, input.limits));
    if (serializedFits(compacted, input.limits)) {
        return compacted;
    }
    const minimalOutput = input.minimal(input.output);
    const serializedMinimal = serializeJson(minimalOutput);
    if (serializedFits(serializedMinimal, input.limits)) {
        return serializedMinimal;
    }
    const compactMinimal = JSON.stringify(minimalOutput);
    if (serializedFits(compactMinimal, input.limits)) {
        return compactMinimal;
    }
    const diagnosticsOutput = input.diagnosticsFocused(input.output);
    const serializedDiagnostics = serializeJson(diagnosticsOutput);
    if (serializedFits(serializedDiagnostics, input.limits)) {
        return serializedDiagnostics;
    }
    const compactDiagnostics = JSON.stringify(diagnosticsOutput);
    return serializedFits(compactDiagnostics, input.limits)
        ? compactDiagnostics
        : forceFitSerialized(compactDiagnostics, input.limits);
}
function serializeJson(value) {
    return JSON.stringify(value, null, 2);
}
function serializedFits(serialized, limits) {
    return ((limits.maxBytes === undefined || Buffer.byteLength(serialized, "utf8") <= limits.maxBytes) &&
        (limits.maxLines === undefined || serialized.split("\n").length <= limits.maxLines));
}
function forceFitSerialized(serialized, limits) {
    let output = serialized;
    if (limits.maxLines !== undefined) {
        output = output.split("\n").slice(0, Math.max(limits.maxLines, 0)).join("\n");
    }
    if (limits.maxBytes !== undefined) {
        output = truncateUtf8(output, Math.max(limits.maxBytes, 0));
    }
    return output;
}
function truncateUtf8(value, maxBytes) {
    let output = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
    while (Buffer.byteLength(output, "utf8") > maxBytes) {
        output = output.slice(0, -1);
    }
    return output;
}
function compactSearchOutput(output, limits) {
    for (const maxTextLength of SEARCH_COMPACT_TEXT_LENGTHS) {
        const compacted = {
            ...output,
            results: output.results.map((result) => {
                const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result;
                return { ...rest, text: trimText(text, maxTextLength) };
            }),
            status: statusWithSearchCompaction(output.status),
        };
        if (serializedFits(serializeJson(compacted), limits)) {
            return compacted;
        }
    }
    return {
        ...output,
        results: output.results.map((result) => {
            const { parentText: _parentText, parentRange: _parentRange, text, ...rest } = result;
            return { ...rest, text: trimText(text, 0) };
        }),
        status: statusWithSearchCompaction(output.status),
    };
}
function minimalSearchOutput(output) {
    return {
        status: output.results.length === 0 ? statusWithSearchCompaction(output.status) : output.status,
        results: output.results.map((result, index) => ({
            rank: index + SINGLE_COMPACT_CHILD,
            id: result.topology.current.id,
            label: result.topology.current.label,
            range: result.topology.current.range,
            score: result.score,
            finalScore: result.finalScore,
            retrieval: result.retrieval,
        })),
    };
}
function diagnosticsFocusedSearchOutput(output) {
    return {
        status: output.status.status,
        resultCount: output.results.length,
        diagnostics: diagnosticsWithSearchCompaction(output.status.diagnostics),
    };
}
function compactChunkLookupOutput(output, limits) {
    for (const maxTextLength of LOOKUP_COMPACT_TEXT_LENGTHS) {
        for (const maxChildren of LOOKUP_COMPACT_CHILD_LIMITS) {
            const compacted = compactChunkLookupOutputWith(output, maxTextLength, maxChildren);
            if (serializedFits(serializeJson(compacted), limits)) {
                return compacted;
            }
        }
    }
    return compactChunkLookupOutputWith(output, 0, 0);
}
function compactChunkLookupOutputWith(output, maxTextLength, maxChildren) {
    if (!output.chunk) {
        return { ...output, status: statusWithLookupCompaction(output.status) };
    }
    const { parentText: _parentText, parentRange: _parentRange, text, related, ...chunk } = output.chunk;
    const children = related.children.slice(0, maxChildren).map(compactRelatedChunk);
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
        status: statusWithLookupCompaction(output.status),
    };
}
function compactRelatedChunk(chunk) {
    if (!chunk) {
        return chunk;
    }
    const { text: _text, ...rest } = chunk;
    return rest;
}
function minimalChunkLookupOutput(output) {
    if (!output.chunk) {
        return { status: statusWithLookupCompaction(output.status) };
    }
    return {
        status: statusWithLookupCompaction(output.status),
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
    };
}
function diagnosticsFocusedChunkLookupOutput(output) {
    return {
        status: output.status.status,
        found: Boolean(output.chunk),
        diagnostics: diagnosticsWithLookupCompaction(output.status.diagnostics),
    };
}
function compactChildrenPage(page, emittedChildren) {
    if (emittedChildren === page.limit) {
        return page;
    }
    return {
        ...page,
        limit: emittedChildren,
        hasMore: page.offset + emittedChildren < page.total,
    };
}
function statusWithSearchCompaction(status) {
    return { ...status, diagnostics: diagnosticsWithSearchCompaction(status.diagnostics) };
}
function statusWithLookupCompaction(status) {
    return { ...status, diagnostics: diagnosticsWithLookupCompaction(status.diagnostics) };
}
function diagnosticsWithSearchCompaction(diagnostics) {
    return diagnostics.includes(COMPACTION_DIAGNOSTIC) ? diagnostics : [...diagnostics, COMPACTION_DIAGNOSTIC];
}
function diagnosticsWithLookupCompaction(diagnostics) {
    return diagnostics.includes(LOOKUP_COMPACTION_DIAGNOSTIC)
        ? diagnostics
        : [...diagnostics, LOOKUP_COMPACTION_DIAGNOSTIC];
}
function trimText(text, maxLength) {
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}
function isStoreUnavailableError(error) {
    const message = formatThrownError(error).toLowerCase();
    return (message.includes("sqlite") ||
        message.includes("database") ||
        message.includes("index unavailable") ||
        message.includes("failed to open") ||
        message.includes("unable to open"));
}
function formatThrownError(error) {
    return error instanceof Error ? error.message : String(error);
}
function isSuccessfulWriteToolResult(event) {
    return (event.toolName === "write" &&
        event.isError !== true &&
        typeof event.input === "object" &&
        event.input !== null &&
        "path" in event.input &&
        typeof event.input.path === "string");
}
function worktreeRelativePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return;
    }
    return relative;
}
async function resolveWorktreePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`source path escapes worktree: ${filePath}`);
    }
    const realRoot = await realpath(root);
    const realResolved = await realpath(resolved);
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`source path escapes worktree: ${filePath}`);
    }
    return resolved;
}
export { createPiSemsearchExtensionForTest, piSemsearchExtension };
