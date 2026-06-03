import type { RetrievalIndexStore } from "./retriever.js";
import type { createIndexer } from "./scanner.js";
import type { createIndexStore } from "./store.js";
import type { CastIndex, HydratedChunkSet, IndexMetadata, LexicalChunkCandidate } from "./types.js";
interface VectorCandidateStore {
    searchVectorCandidates(queryEmbedding: number[], topK: number, paths?: string[]): Promise<Array<{
        id: string;
        score: number;
    }> & {
        incomplete?: boolean;
    }>;
}
interface LexicalCandidateStore {
    searchLexicalCandidates(query: string, topK: number, paths?: string[]): Promise<LexicalChunkCandidate[]>;
}
type IndexingStore = Parameters<typeof createIndexer>[0]["store"];
type WrappedIndexingStore = IndexingStore & Partial<VectorCandidateStore>;
declare function createProjectId(worktree: string): string;
declare function hydratedChunkSetToIndex(hydrated: HydratedChunkSet): CastIndex;
declare function hasVectorCandidateStore(value: unknown): value is VectorCandidateStore;
declare function hasLexicalCandidateStore(value: unknown): value is LexicalCandidateStore;
declare function hasReadMetadataStore(value: unknown): value is {
    readMetadata(): Promise<IndexMetadata>;
};
declare function hasHydrateChunksStore(value: unknown): value is Pick<RetrievalIndexStore, "hydrateChunks">;
declare function addRunStoreMethods(wrapped: WrappedIndexingStore, indexStore: NonNullable<ReturnType<typeof createIndexStore>>, wrapStoreOperation: <T>(operation: () => Promise<T>) => Promise<T>): void;
export type { IndexingStore, LexicalCandidateStore, VectorCandidateStore, WrappedIndexingStore };
export { addRunStoreMethods, createProjectId, hasHydrateChunksStore, hasLexicalCandidateStore, hasReadMetadataStore, hasVectorCandidateStore, hydratedChunkSetToIndex, };
