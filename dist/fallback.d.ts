import { type SourceIndex } from "./range.js";
export declare function fallbackChunks(input: {
    filePath: string;
    language: string;
    text: string;
    maxNonWhitespaceChars: number;
    sourceIndex?: SourceIndex;
    byteOffset?: number;
}): {
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
