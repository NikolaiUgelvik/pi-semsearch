import type { ChunkRecord, SearchResultTopology, SymbolRecord, TopologyNode } from "../shared/types.js";
declare function expandWithParentContext(input: {
    chunk: ChunkRecord;
    symbols: Record<string, SymbolRecord>;
    source: string;
    maxContextChars: number;
}): {
    breadcrumbs: string[];
    parentText?: undefined;
    parentRange?: undefined;
} | {
    breadcrumbs: string[];
    parentText: string;
    parentRange: import("../shared/types.js").SourceRange;
};
declare function summarizeTopology(chunk: ChunkRecord, chunks: Record<string, ChunkRecord>, symbols: Record<string, SymbolRecord>): SearchResultTopology;
declare function summarizeChunk(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>): TopologyNode;
declare function chunkMatchesSource(source: string, chunk: ChunkRecord): boolean;
declare function chunkBreadcrumbs(chunk: ChunkRecord, symbols: Record<string, SymbolRecord>): string[];
export { chunkBreadcrumbs as summaryChunkBreadcrumbs, chunkMatchesSource as summaryChunkMatchesSource, expandWithParentContext as summaryExpandWithParentContext, summarizeChunk as summarySummarizeChunk, summarizeTopology as summarySummarizeTopology, };
