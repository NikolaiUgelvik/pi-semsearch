import { createHash } from "node:crypto";
import path from "node:path";
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
export { addRunStoreMethods, createProjectId, hasHydrateChunksStore, hasLexicalCandidateStore, hasReadMetadataStore, hasVectorCandidateStore, hydratedChunkSetToIndex, };
