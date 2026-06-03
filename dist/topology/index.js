import { linkChunkTopology, linkSymbolsToChunks } from "./relations.js";
import { summaryChunkBreadcrumbs, summaryChunkMatchesSource, summaryExpandWithParentContext, summarySummarizeChunk, summarySummarizeTopology, } from "./summary.js";
import { extractSymbolRecords } from "./symbols.js";
function extractSymbols(input) {
    return extractSymbolRecords(input);
}
function assignSymbolsToChunks(chunks, symbols) {
    return linkSymbolsToChunks(chunks, symbols);
}
function attachTopology(chunks, symbols) {
    return linkChunkTopology(chunks, symbols);
}
function expandWithParentContext(input) {
    return summaryExpandWithParentContext(input);
}
function summarizeTopology(...input) {
    return summarySummarizeTopology(...input);
}
function summarizeChunk(...input) {
    return summarySummarizeChunk(...input);
}
function chunkMatchesSource(...input) {
    return summaryChunkMatchesSource(...input);
}
function chunkBreadcrumbs(...input) {
    return summaryChunkBreadcrumbs(...input);
}
export { assignSymbolsToChunks, attachTopology, chunkBreadcrumbs, chunkMatchesSource, expandWithParentContext, extractSymbols, summarizeChunk, summarizeTopology, };
