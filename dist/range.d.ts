import type { SourceRange } from "./types.js";
export declare function nonWhitespaceLength(text: string): number;
export declare function rangeForSlice(source: string, byteStart: number, byteEnd: number): SourceRange;
export declare function stableChunkId(filePath: string, byteStart: number, byteEnd: number): string;
export declare function textForByteSlice(source: string, byteStart: number, byteEnd: number): string;
