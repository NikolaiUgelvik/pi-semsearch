import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import { getChunkById } from "./chunk-lookup.js"
import { HYDE_SYSTEM_PROMPT } from "./hyde.js"
import { parseSource } from "./language.js"
import { createOpenAIClient, type FetchLike } from "./openai.js"
import { parseOptions } from "./options.js"
import { type RetrievalIndexStore, retrieveFromStore } from "./retriever.js"
import { createIndexer } from "./scanner.js"
import { createIndexStore } from "./store.js"
import type { ChunkLookupOutput, LexicalChunkCandidate, SearchOutput } from "./types.js"

interface VectorCandidateStore {
  searchVectorCandidates(
    queryEmbedding: number[],
    topK: number,
    paths?: string[],
  ): Promise<Array<{ id: string; score: number }>>
}

interface LexicalCandidateStore {
  searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>
}

type IndexingStore = Parameters<typeof createIndexer>[0]["store"]
type WrappedIndexingStore = IndexingStore & Partial<VectorCandidateStore>

interface OpenCodeHydeClient {
  session: {
    create(parameters: { body?: { parentID?: string; title?: string }; query?: { directory?: string } }): Promise<{
      data?: { id: string }
      error?: unknown
    }>
    prompt(parameters: {
      path: { id: string }
      query?: { directory?: string }
      body?: {
        model?: { providerID: string; modelID: string }
        tools?: Record<string, boolean>
        system?: string
        parts: Array<{ type: string; text?: string }>
      }
    }): Promise<{
      data?: { parts: Array<{ type: string; text?: string }> }
      error?: unknown
    }>
    delete(parameters: { path: { id: string }; query?: { directory?: string } }): Promise<{
      data?: boolean
      error?: unknown
    }>
  }
}

interface ToolOutputLimits {
  maxLines?: number
  maxBytes?: number
}

const COMPACTION_DIAGNOSTIC =
  "output compacted to fit opencode tool_output limits; use semantic_get_chunk for more context"
const LOOKUP_COMPACTION_DIAGNOSTIC =
  "output compacted to fit opencode tool_output limits; narrow semantic_get_chunk args, page children, reduce included relations, or increase opencode tool_output limits"
const LONG_COMPACT_TEXT_LENGTH = 200
const MEDIUM_COMPACT_TEXT_LENGTH = 80
const SHORT_COMPACT_TEXT_LENGTH = 20
const HYDE_PROMPT_FIRST_RETRY_DELAY_MS = 100
const HYDE_PROMPT_SECOND_RETRY_DELAY_MS = 250
const HYDE_PROMPT_RETRY_DELAYS_MS = [HYDE_PROMPT_FIRST_RETRY_DELAY_MS, HYDE_PROMPT_SECOND_RETRY_DELAY_MS]
const OMITTED_TEXT_LENGTH = 0
const MANY_COMPACT_CHILDREN = 5
const SINGLE_COMPACT_CHILD = 1
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

export function createCastPluginForTest(
  dependencies: {
    fetch?: FetchLike
    createStore?: typeof createIndexStore
    createIndexer?: typeof createIndexer
    retrieve?: typeof retrieveFromStore
  } = {},
): Plugin {
  return async (input, rawOptions) => {
    const options = parseOptions(rawOptions)
    const storeInput = {
      cacheDir: options.cacheDir,
      cacheKey: createHash("sha256")
        .update(
          JSON.stringify({
            projectId: input.project.id,
            worktree: input.worktree,
            embedding: options.embedding
              ? {
                  baseURL: options.embedding.baseURL,
                  model: options.embedding.model,
                  dimensions: options.embedding.dimensions,
                }
              : "missing",
            maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
          }),
        )
        .digest("hex"),
      embeddingDimensions: options.embedding?.dimensions,
    }
    let store: ReturnType<typeof createIndexStore> | undefined
    let storeError: string | undefined
    try {
      store = (dependencies.createStore ?? createIndexStore)(storeInput)
    } catch (error) {
      storeError = formatThrownError(error)
    }
    const client = createOpenAIClient(dependencies.fetch ? { fetch: dependencies.fetch } : {})
    const sessionModels = new Map<string, { providerID: string; modelID: string }>()
    let outputLimits: ToolOutputLimits = {}
    let refresh: Promise<unknown> | undefined
    let refreshTail = Promise.resolve()

    const queueRefresh = (refreshInput: { background?: boolean } = {}) => {
      const embedding = options.embedding
      if (!(embedding && store) || storeError) {
        return Promise.resolve()
      }
      const indexStore = store
      refresh = refreshTail
        .then(() => {
          if (storeError) {
            return
          }
          const indexingStore = wrapIndexingStore(indexStore)
          return (dependencies.createIndexer ?? createIndexer)({
            worktree: input.worktree,
            options: {
              maxChunkNonWhitespaceChars: options.maxChunkNonWhitespaceChars,
              maxFileBytes: options.maxFileBytes,
              includeGlobs: options.includeGlobs,
              excludeGlobs: options.excludeGlobs,
              topK: options.topK,
              maxContextChars: options.maxContextChars,
              chunking: options.chunking,
              embeddingBatchSize: embedding.batchSize,
            },
            store: indexingStore,
            parse: parseSource,
            embed: (text) => client.embed({ ...embedding, input: text }),
            embedBatch: (texts) => client.embedBatch({ ...embedding, input: texts }),
          }).refresh()
        })
        .catch((error) => {
          if (error instanceof IndexUnavailableError) {
            storeError = error.message
            return
          }
          if (!refreshInput.background) {
            throw error
          }
          return
        })
      refreshTail = refresh.then(
        () => undefined,
        () => undefined,
      )
      return refresh
    }

    const recordStoreUnavailable = (error: unknown) => {
      if (!isStoreUnavailableError(error)) {
        return false
      }
      storeError = formatThrownError(error)
      return true
    }

    const readIndex = async () => {
      if (!store) {
        throw new Error(storeError ?? "index unavailable")
      }
      try {
        return await store.read()
      } catch (error) {
        if (!recordStoreUnavailable(error)) {
          throw error
        }
        throw new IndexUnavailableError(storeError ?? formatThrownError(error))
      }
    }

    const wrapStoreOperation = async <T>(operation: () => Promise<T>) => {
      try {
        return await operation()
      } catch (error) {
        if (!recordStoreUnavailable(error)) {
          throw error
        }
        throw new IndexUnavailableError(storeError ?? formatThrownError(error))
      }
    }

    const wrapIndexingStore = (indexStore: typeof store): IndexingStore => {
      if (!indexStore) {
        throw new IndexUnavailableError(storeError ?? "index unavailable")
      }
      const wrapped: WrappedIndexingStore = {
        read: () => wrapStoreOperation(() => indexStore.read()),
        write: (index) => wrapStoreOperation(() => indexStore.write(index)),
      }
      addRunStoreMethods(wrapped, indexStore, wrapStoreOperation)
      if (hasVectorCandidateStore(indexStore)) {
        wrapped.searchVectorCandidates = (queryEmbedding: number[], topK: number, paths?: string[]) =>
          wrapStoreOperation(() => indexStore.searchVectorCandidates(queryEmbedding, topK, paths))
      }
      return wrapped
    }

    const retrievalIndexStore = (): RetrievalIndexStore => {
      if (!store) {
        throw new IndexUnavailableError(storeError ?? "index unavailable")
      }
      const indexStore = store
      const wrapped: RetrievalIndexStore = {
        readMetadata: async () => {
          if (!hasReadMetadataStore(indexStore)) {
            throw new IndexUnavailableError(storeError ?? "index unavailable")
          }
          try {
            return await indexStore.readMetadata()
          } catch (error) {
            if (!recordStoreUnavailable(error)) {
              throw error
            }
            throw new IndexUnavailableError(storeError ?? formatThrownError(error))
          }
        },
        searchVectorCandidates: async (queryEmbedding, topK, paths) => {
          if (!hasVectorCandidateStore(indexStore)) {
            throw new IndexUnavailableError(storeError ?? "index unavailable")
          }
          try {
            return await indexStore.searchVectorCandidates(queryEmbedding, topK, paths)
          } catch (error) {
            if (!recordStoreUnavailable(error)) {
              throw error
            }
            throw new IndexUnavailableError(storeError ?? formatThrownError(error))
          }
        },
        hydrateChunks: async (chunkIds) => {
          if (!hasHydrateChunksStore(indexStore)) {
            throw new IndexUnavailableError(storeError ?? "index unavailable")
          }
          try {
            return await indexStore.hydrateChunks(chunkIds)
          } catch (error) {
            if (!recordStoreUnavailable(error)) {
              throw error
            }
            throw new IndexUnavailableError(storeError ?? formatThrownError(error))
          }
        },
      }
      if (hasLexicalCandidateStore(indexStore)) {
        wrapped.searchLexicalCandidates = async (query, topK, paths) => {
          try {
            return await indexStore.searchLexicalCandidates(query, topK, paths)
          } catch (error) {
            if (!recordStoreUnavailable(error)) {
              throw error
            }
            throw new IndexUnavailableError(storeError ?? formatThrownError(error))
          }
        }
      }
      return wrapped
    }

    queueInitialRefresh(options, queueRefresh)

    const semanticSearchUnavailable = () => {
      if (!options.embedding || options.diagnostics.length > 0) {
        return {
          title: "Semantic code search is not configured",
          output: options.diagnostics.join("\n"),
          metadata: { configured: false },
        }
      }
      return store ? undefined : unavailableToolResult("Semantic code search index unavailable", storeError)
    }

    const semanticSearchOutput = async (
      args: Parameters<typeof retrieveFromStore>[0]["input"],
      context: ToolContext,
    ) => {
      const embedding = options.embedding
      if (!embedding) {
        throw new Error("embedding dependency unavailable")
      }
      await ensureSearchIndexReady(
        args.refresh === true,
        queueRefresh,
        () => refresh,
        () => storeError,
      )
      try {
        return await (dependencies.retrieve ?? retrieveFromStore)({
          input: args,
          options: { ...options, hybrid: options.retrieval.hybrid, rerank: options.rerank },
          embed: (text) => client.embed({ ...embedding, input: text }),
          generateHyde: (query) =>
            generateHydeText({ query, context, hyde: options.hyde, client, generateOpenCodeHyde }),
          rerank: (query, documents) => rerankDocuments(query, documents, options.rerank, client),
          readSource: async (filePath) => Bun.file(await resolveWorktreePath(input.worktree, filePath)).text(),
          indexStore: retrievalIndexStore(),
        })
      } catch (error) {
        if (!(error instanceof IndexUnavailableError)) {
          throw error
        }
        throw new IndexUnavailableError(storeError ?? formatThrownError(error))
      }
    }

    const generateOpenCodeHyde = async (query: string, context: ToolContext) => {
      const model = sessionModels.get(context.sessionID)
      if (!model) {
        throw new Error(`No opencode model is tracked for session ${context.sessionID}`)
      }
      const opencodeClient = input.client as unknown as OpenCodeHydeClient | undefined
      if (!opencodeClient?.session) {
        throw new Error("OpenCode client is not available for HyDE generation")
      }
      return generateOpenCodeHydeText({ client: opencodeClient, query, context, model })
    }

    return {
      config: async (cfg) => {
        const toolOutput = (cfg as { tool_output?: { max_lines?: unknown; max_bytes?: unknown } }).tool_output
        outputLimits = {
          maxLines: typeof toolOutput?.max_lines === "number" ? toolOutput.max_lines : undefined,
          maxBytes: typeof toolOutput?.max_bytes === "number" ? toolOutput.max_bytes : undefined,
        }
      },
      "chat.message": async (event) => {
        if (event.model) {
          sessionModels.set(event.sessionID, event.model)
        }
      },
      tool: {
        semantic_search_code: tool({
          description: `
Find relevant code in the current repository by meaning instead of exact text, symbol, or implementation intent.

Use this as the default first tool for code discovery in this repository, including when the user asks how something works, where behavior, features, APIs, errors, data flow, or relevant code lives, or asks about a known class, function, method, type, test, or feature name. Prefer this before grep/glob/read because it returns ranked, syntax-aware matches with surrounding implementation context and file/line references.

Search results are compact ranked matches by default. Each result includes matched chunk text, scores, breadcrumbs, retrieval details, and topology IDs/labels. Parent body text is returned only when includeParents is true. Use semantic_get_chunk with topology IDs for expanded parent/sibling/child context.

This tool searches syntax-aware code chunks such as functions, classes, methods, and nearby context where parser support is available. Use grep only when you need exhaustive literal matching, occurrence counts, mechanical text replacement preparation, or matches in files that are not meaningfully represented as code chunks. Use read after this tool returns candidates when you need larger surrounding context or exact verification. Use paths to restrict the search area. Use refresh if files may have changed since the index was built.
`,
          args: {
            query: tool.schema.string(),
            topK: tool.schema.number().int().positive().optional(),
            minFinalScore: tool.schema.number().optional(),
            maxContextChars: tool.schema.number().int().positive().optional(),
            includeParents: tool.schema.boolean().optional(),
            refresh: tool.schema.boolean().optional(),
            paths: tool.schema.array(tool.schema.string()).optional(),
          },
          async execute(args, context) {
            const unavailable = semanticSearchUnavailable()
            if (unavailable) {
              return unavailable
            }
            try {
              const output = await semanticSearchOutput(args, context)
              return searchToolResult(args.query, output, outputLimits)
            } catch (error) {
              if (!(error instanceof IndexUnavailableError)) {
                throw error
              }
              return unavailableToolResult("Semantic code search index unavailable", storeError)
            }
          },
        }),
        semantic_get_chunk: tool({
          description: `
Fetch an indexed semantic code chunk by ID returned from semantic_search_code.

Use this after semantic_search_code when you need the exact cached chunk, expanded parent context, or nearby topology such as parents, siblings, and children. Use childrenOffset and childrenLimit to page large child lists; the response includes related.childrenPage metadata so callers can request more children when hasMore is true.
`,
          args: {
            id: tool.schema.string(),
            includeParents: tool.schema.boolean().optional(),
            includeSiblings: tool.schema.boolean().optional(),
            includeChildren: tool.schema.boolean().optional(),
            childrenOffset: tool.schema.number().int().optional(),
            childrenLimit: tool.schema.number().int().optional(),
            maxContextChars: tool.schema.number().int().positive().optional(),
          },
          async execute(args) {
            if (!options.embedding || options.diagnostics.length > 0) {
              return {
                title: "Semantic chunk lookup is not configured",
                output: options.diagnostics.join("\n"),
                metadata: { configured: false },
              }
            }
            if (!store) {
              return unavailableToolResult("Semantic chunk lookup index unavailable", storeError)
            }

            await refresh
            if (storeError) {
              return unavailableToolResult("Semantic chunk lookup index unavailable", storeError)
            }
            let output: Awaited<ReturnType<typeof getChunkById>>
            try {
              output = await getChunkById({
                index: await readIndex(),
                input: args,
                readSource: async (filePath) => Bun.file(await resolveWorktreePath(input.worktree, filePath)).text(),
              })
            } catch (error) {
              if (!(error instanceof IndexUnavailableError)) {
                throw error
              }
              return unavailableToolResult("Semantic chunk lookup index unavailable", storeError)
            }

            return {
              title: `Semantic chunk lookup: ${args.id}`,
              output: serializeToolOutput({
                output,
                limits: outputLimits,
                compact: compactChunkLookupOutput,
                minimal: minimalChunkLookupOutput,
                diagnosticsFocused: diagnosticsFocusedChunkLookupOutput,
              }),
              metadata: { found: Boolean(output.chunk) },
            }
          },
        }),
      },
      async dispose() {
        sessionModels.clear()
        refresh = undefined
        refreshTail = Promise.resolve()
      },
    }
  }
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

function hasReadMetadataStore(value: unknown): value is Pick<RetrievalIndexStore, "readMetadata"> {
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
    metadata: { configured: false },
  }
}

function searchToolResult(query: string, output: SearchOutput, limits: ToolOutputLimits) {
  return {
    title: `Semantic code search: ${query}`,
    output: serializeToolOutput({
      output,
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

function queueInitialRefresh(
  options: ReturnType<typeof parseOptions>,
  queueRefresh: (input: { background?: boolean }) => Promise<unknown>,
) {
  if (options.embedding && options.diagnostics.length === 0) {
    queueRefresh({ background: true })
  }
}

async function ensureSearchIndexReady(
  shouldRefresh: boolean,
  queueRefresh: () => Promise<unknown>,
  currentRefresh: () => Promise<unknown> | undefined,
  currentStoreError: () => string | undefined,
) {
  if (shouldRefresh) {
    await queueRefresh()
  }
  await currentRefresh()
  const storeError = currentStoreError()
  if (storeError) {
    throw new IndexUnavailableError(storeError)
  }
}

function generateHydeText(input: {
  query: string
  context: ToolContext
  hyde: ReturnType<typeof parseOptions>["hyde"]
  client: ReturnType<typeof createOpenAIClient>
  generateOpenCodeHyde: (query: string, context: ToolContext) => Promise<string>
}) {
  const openAiHyde = openAiHydeInput(input.query, input.hyde)
  return openAiHyde ? input.client.generateHyde(openAiHyde) : input.generateOpenCodeHyde(input.query, input.context)
}

function openAiHydeInput(query: string, hyde: ReturnType<typeof parseOptions>["hyde"]) {
  return hyde.mode === "openai-compatible" && hyde.baseURL && hyde.model
    ? { baseURL: hyde.baseURL, apiKey: hyde.apiKey, model: hyde.model, query }
    : undefined
}

function rerankDocuments(
  query: string,
  documents: string[],
  rerank: ReturnType<typeof parseOptions>["rerank"],
  client: ReturnType<typeof createOpenAIClient>,
) {
  return rerank
    ? client.rerank({
        baseURL: rerank.baseURL,
        apiKey: rerank.apiKey,
        model: rerank.model,
        query,
        documents,
      })
    : Promise.reject(new Error("Rerank is not configured"))
}

async function generateOpenCodeHydeText(input: {
  client: OpenCodeHydeClient
  query: string
  context: ToolContext
  model: { providerID: string; modelID: string }
}) {
  const hydeSessionID = await createHydeSession(input.client, input.context)
  try {
    return await hydePromptText(input.client, hydeSessionID, input)
  } finally {
    await deleteHydeSession(input.client, hydeSessionID, input.context)
  }
}

async function createHydeSession(client: OpenCodeHydeClient, context: ToolContext) {
  const created = await client.session.create({
    body: { parentID: context.sessionID, title: "OpenCode Cast HyDE" },
    query: { directory: context.directory },
  })
  if (created.error) {
    throw new Error(`OpenCode HyDE session create failed: ${formatSdkError(created.error)}`)
  }
  if (!created.data?.id) {
    throw new Error("OpenCode HyDE session create returned no session id")
  }
  return created.data.id
}

async function hydePromptText(
  client: OpenCodeHydeClient,
  hydeSessionID: string,
  input: { query: string; context: ToolContext; model: { providerID: string; modelID: string } },
) {
  const parameters = {
    path: { id: hydeSessionID },
    query: { directory: input.context.directory },
    body: {
      model: input.model,
      tools: {},
      system: HYDE_SYSTEM_PROMPT,
      parts: [{ type: "text", text: input.query }],
    },
  }
  let prompted = await client.session.prompt(parameters)
  for (const delayMs of HYDE_PROMPT_RETRY_DELAYS_MS) {
    if (!isSessionNotFoundError(prompted.error)) {
      break
    }
    // Retries must be sequential because each one waits for opencode to make the new child session visible.
    // biome-ignore lint: the retry delay is intentionally ordered.
    await delay(delayMs)
    prompted = await client.session.prompt(parameters)
  }
  if (prompted.error) {
    throw new Error(`OpenCode HyDE prompt failed: ${formatSdkError(prompted.error)}`)
  }
  if (!prompted.data) {
    throw new Error("OpenCode HyDE prompt returned no response")
  }
  return nonEmptyHydeText(prompted.data.parts)
}

function isSessionNotFoundError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotFoundError" &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string" &&
    error.data.message.startsWith("Session not found:")
  )
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nonEmptyHydeText(parts: Array<{ type: string; text?: string }>) {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
  if (!text) {
    throw new Error("OpenCode HyDE prompt returned no text")
  }
  return text
}

function deleteHydeSession(client: OpenCodeHydeClient, hydeSessionID: string, context: ToolContext) {
  return client.session
    .delete({ path: { id: hydeSessionID }, query: { directory: context.directory } })
    .catch(() => undefined)
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
  return serializedFits(compactDiagnostics, input.limits) ? compactDiagnostics : serializedDiagnostics
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
      id: result.topology.chunk.id,
      label: result.topology.chunk.label,
      range: result.topology.chunk.range,
      score: result.score,
      finalScore: result.finalScore,
      retrieval: result.retrieval,
    })),
    diagnostics: diagnosticsWithSearchCompaction(output.diagnostics),
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

export const castPlugin = createCastPluginForTest()

function formatSdkError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
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
