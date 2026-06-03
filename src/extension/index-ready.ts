import type { createOpenAIClient } from "../embeddings/openai.js"
import type { parseOptions } from "../options/index.js"
import type { IndexMetadata, SearchOutput } from "../shared/types.js"
import type { createIndexStore } from "../store/index.js"
import { IndexUnavailableError } from "./errors.js"
import { hasReadMetadataStore } from "./store.js"

const INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; results may be stale"
const INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC =
  "index refresh in progress; no searchable active index is available yet"

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

export {
  appendSearchDiagnostic,
  ensureSearchIndexReady,
  INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC,
  INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC,
  queueInitialRefresh,
  rerankDocuments,
}
