import type { ChunkRecord, LexicalIndex, SymbolRecord } from "./types.js";
type RankedResult = {
    id: string;
    score: number;
};
declare function tokenizeCodeText(input: string): string[];
declare function buildLexicalIndex(chunks: Record<string, ChunkRecord>, symbols: Record<string, SymbolRecord>): {
    lexical: LexicalIndex;
    chunks: Record<string, ChunkRecord>;
};
declare function reciprocalRankFusion(input: {
    lists: {
        weight: number;
        results: RankedResult[];
    }[];
    rrfK: number;
    topK: number;
}): RankedResult[];
export type { RankedResult };
export { buildLexicalIndex, reciprocalRankFusion, tokenizeCodeText };
