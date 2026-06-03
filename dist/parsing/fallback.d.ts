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
    kind: import("../shared/types.js").ChunkKind;
    range: import("../shared/types.js").SourceRange;
    text: string;
    nonWhitespaceChars: number;
    nodeTypes: string[];
    symbolIds: string[];
    parentChunkId?: string;
    childChunkIds: string[];
    embedding?: number[];
    embeddingError?: string;
    lexical?: import("../shared/types.js").ChunkLexicalStats;
}[];
