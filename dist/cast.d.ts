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
    root: SyntaxNode;
    maxNonWhitespaceChars: number;
    chunking: ChunkingOptions;
}): ChunkRecord[];
