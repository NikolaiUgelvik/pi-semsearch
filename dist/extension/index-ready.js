import { IndexUnavailableError } from "./errors.js";
import { hasReadMetadataStore } from "./store.js";
const INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; results may be stale";
const INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC = "index refresh in progress; no searchable active index is available yet";
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
export { appendSearchDiagnostic, ensureSearchIndexReady, INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC, INITIAL_INDEX_REFRESH_IN_PROGRESS_DIAGNOSTIC, queueInitialRefresh, rerankDocuments, };
