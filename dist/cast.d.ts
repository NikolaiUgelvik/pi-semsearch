import { type SourceIndex } from "./range.js";
import type { ChunkingOptions, ChunkRecord } from "./types.js";
export type SyntaxNode = {
    type: string;
    startIndex: number;
    endIndex: number;
    children: SyntaxNode[];
};
export declare function castChunks(input: {
    filePath: string;
    language: string;
    source: string;
    sourceIndex?: SourceIndex;
    root: SyntaxNode;
    maxNonWhitespaceChars: number;
    chunking: ChunkingOptions;
}): ChunkRecord[];
