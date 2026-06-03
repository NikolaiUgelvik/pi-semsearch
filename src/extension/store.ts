import { createHash } from "node:crypto"
import path from "node:path"
import type { RetrievalIndexStore } from "../retriever/index.js"
import type { createIndexer } from "../scanner/index.js"
import type { CastIndex, HydratedChunkSet, IndexMetadata, LexicalChunkCandidate } from "../shared/types.js"
import type { createIndexStore } from "../store/index.js"

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

export type { IndexingStore, LexicalCandidateStore, VectorCandidateStore, WrappedIndexingStore }
export {
  addRunStoreMethods,
  createProjectId,
  hasHydrateChunksStore,
  hasLexicalCandidateStore,
  hasReadMetadataStore,
  hasVectorCandidateStore,
  hydratedChunkSetToIndex,
}
