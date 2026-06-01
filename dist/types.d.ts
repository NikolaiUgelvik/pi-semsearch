export type SourceRange = {
    byteStart: number;
    byteEnd: number;
    lineStart: number;
    lineEnd: number;
};
export type ChunkKind = "file" | "class" | "function" | "method" | "block" | "fallback";
export type HybridRetrievalOptions = {
    enabled: boolean;
    rrfK: number;
    vectorCandidateMultiplier: number;
    bm25CandidateMultiplier: number;
    vectorWeight: number;
    bm25Weight: number;
};
export type RerankOptions = {
    baseURL: string;
    apiKey?: string;
    model: string;
    candidateMultiplier: number;
};
export type HydeOptions = {
    mode: "openai-compatible" | "opencode";
    baseURL?: string;
    apiKey?: string;
    model?: string;
    threshold: number;
    enabled: boolean;
};
export type ChunkingOptions = {
    overlap: number;
    expansion: boolean;
    minSemanticNonWhitespaceChars: number;
};
export type DiagnosticCode = "index.skipped_file" | "source.read_failed" | "source.mismatch" | "hyde.failed" | "retrieval.knn_capped" | "output.compacted" | "diagnostic.unknown";
export type DiagnosticRecord = {
    code: DiagnosticCode;
    message: string;
    filePath?: string;
    chunkId?: string;
};
export type LexicalIndex = {
    documentCount: number;
    averageDocumentLength: number;
    documentFrequencies: Record<string, number>;
};
export type ChunkLexicalStats = {
    length: number;
    termFrequencies: Record<string, number>;
};
export type SearchResultRetrievalDetails = {
    mode: "vector" | "hybrid";
    vectorRank?: number;
    bm25Rank?: number;
    bm25Score?: number;
    rerankRank?: number;
    rerankScore?: number;
};
export type RankedChunkCandidate = {
    id: string;
    score: number;
};
export type LexicalChunkCandidate = RankedChunkCandidate & {
    bm25Score: number;
};
export type HydratedChunkSet = {
    metadata: IndexMetadata;
    files: Record<string, FileRecord>;
    chunks: Record<string, ChunkRecord>;
    symbols: Record<string, SymbolRecord>;
    lexical?: LexicalIndex;
    diagnostics: string[];
    diagnosticDetails?: DiagnosticRecord[];
};
export type ChunkRecord = {
    id: string;
    filePath: string;
    language: string;
    kind: ChunkKind;
    range: SourceRange;
    text: string;
    nonWhitespaceChars: number;
    nodeTypes: string[];
    symbolIds: string[];
    parentChunkId?: string;
    childChunkIds: string[];
    previousSiblingChunkId?: string;
    nextSiblingChunkId?: string;
    embedding?: number[];
    embeddingError?: string;
    lexical?: ChunkLexicalStats;
};
export type SymbolRecord = {
    id: string;
    name: string;
    kind: "module" | "class" | "function" | "method" | "interface";
    filePath: string;
    range: SourceRange;
    parentSymbolId?: string;
    childSymbolIds: string[];
};
export type FileRecord = {
    path: string;
    language: string;
    fingerprint: string;
    chunkIds: string[];
    diagnostics: string[];
};
export type IndexMetadata = {
    schemaVersion: number;
    projectId: string;
    worktree: string;
    cacheKey: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    maxFileBytes?: number;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxChunkNonWhitespaceChars: number;
    chunking: ChunkingOptions;
    updatedAt: number;
    status: "empty" | "indexing" | "ready" | "stale" | "error";
    diagnostics: string[];
    diagnosticDetails?: DiagnosticRecord[];
};
export type CastIndex = {
    metadata: IndexMetadata;
    files: Record<string, FileRecord>;
    chunks: Record<string, ChunkRecord>;
    symbols: Record<string, SymbolRecord>;
    lexical?: LexicalIndex;
};
export type SearchInput = {
    query: string;
    topK?: number;
    maxContextChars?: number;
    includeParents?: boolean;
    refresh?: boolean;
    paths?: string[];
    minFinalScore?: number;
};
export type TopologyNode = {
    id: string;
    label: string;
    range: string;
};
export type SearchResultTopology = {
    chunk: TopologyNode;
    parent?: TopologyNode;
    children: TopologyNode[];
    previousSibling?: TopologyNode;
    nextSibling?: TopologyNode;
    symbols: string[];
};
export type ChunkLookupInput = {
    id: string;
    includeParents?: boolean;
    includeSiblings?: boolean;
    includeChildren?: boolean;
    childrenOffset?: number;
    childrenLimit?: number;
    maxContextChars?: number;
};
export type ChunkLookupChildrenPage = {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
};
export type ChunkLookupOutput = {
    status: IndexMetadata;
    chunk?: {
        filePath: string;
        language: string;
        range: SourceRange;
        kind: ChunkKind;
        breadcrumbs: string[];
        text: string;
        parentText?: string;
        parentRange?: SourceRange;
        topology: SearchResultTopology;
        related: {
            parent?: ChunkLookupRelatedChunk;
            previousSibling?: ChunkLookupRelatedChunk;
            nextSibling?: ChunkLookupRelatedChunk;
            children: ChunkLookupRelatedChunk[];
            childrenPage: ChunkLookupChildrenPage;
        };
    };
    diagnostics: string[];
    diagnosticDetails?: DiagnosticRecord[];
};
export type ChunkLookupRelatedChunk = {
    id: string;
    label: string;
    range: string;
    text?: string;
};
export type SearchResult = {
    filePath: string;
    language: string;
    range: SourceRange;
    score: number;
    finalScore: number;
    kind: ChunkKind;
    breadcrumbs: string[];
    text: string;
    parentText?: string;
    parentRange?: SourceRange;
    topology: SearchResultTopology;
    retrieval?: SearchResultRetrievalDetails;
};
export type SearchOutput = {
    status: IndexMetadata & {
        hydeUsed: boolean;
        bestScore?: number;
        rerankUsed: boolean;
        minFinalScore: number;
        filteredCount: number;
        candidateCount: number;
    };
    results: SearchResult[];
    diagnostics: string[];
    diagnosticDetails?: DiagnosticRecord[];
};
