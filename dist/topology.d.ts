import type { SyntaxNode } from "./cast.js";
import type { SourceIndex } from "./range.js";
import { summaryChunkBreadcrumbs, summaryChunkMatchesSource, summaryExpandWithParentContext, summarySummarizeChunk, summarySummarizeTopology } from "./topology-summary.js";
import type { ChunkRecord, SymbolRecord } from "./types.js";
declare function extractSymbols(input: {
    filePath: string;
    source: string;
    sourceIndex?: SourceIndex;
    nodes: SyntaxNode[];
}): {
    childSymbolIds: string[];
    id: string;
    name: string;
    kind: "module" | "class" | "function" | "method" | "interface";
    filePath: string;
    range: import("./types.js").SourceRange;
    parentSymbolId?: string;
}[];
declare function assignSymbolsToChunks(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>): {
    symbolIds: string[];
    id: string;
    filePath: string;
    language: string;
    kind: import("./types.js").ChunkKind;
    range: import("./types.js").SourceRange;
    text: string;
    nonWhitespaceChars: number;
    nodeTypes: string[];
    parentChunkId?: string;
    childChunkIds: string[];
    previousSiblingChunkId?: string;
    nextSiblingChunkId?: string;
    embedding?: number[];
    embeddingError?: string;
    lexical?: import("./types.js").ChunkLexicalStats;
}[];
declare function attachTopology(chunks: ChunkRecord[], symbols: Record<string, SymbolRecord>): {
    previousSiblingChunkId: string;
    nextSiblingChunkId: string;
    id: string;
    filePath: string;
    language: string;
    kind: import("./types.js").ChunkKind;
    range: import("./types.js").SourceRange;
    text: string;
    nonWhitespaceChars: number;
    nodeTypes: string[];
    symbolIds: string[];
    parentChunkId?: string;
    childChunkIds: string[];
    embedding?: number[];
    embeddingError?: string;
    lexical?: import("./types.js").ChunkLexicalStats;
}[];
declare function expandWithParentContext(input: Parameters<typeof summaryExpandWithParentContext>[0]): {
    breadcrumbs: string[];
    parentText?: undefined;
    parentRange?: undefined;
} | {
    breadcrumbs: string[];
    parentText: string;
    parentRange: import("./types.js").SourceRange;
};
declare function summarizeTopology(...input: Parameters<typeof summarySummarizeTopology>): import("./types.js").SearchResultTopology;
declare function summarizeChunk(...input: Parameters<typeof summarySummarizeChunk>): import("./types.js").TopologyNode;
declare function chunkMatchesSource(...input: Parameters<typeof summaryChunkMatchesSource>): boolean;
declare function chunkBreadcrumbs(...input: Parameters<typeof summaryChunkBreadcrumbs>): string[];
export { assignSymbolsToChunks, attachTopology, chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, extractSymbols, summarizeChunk, summarizeTopology, };
