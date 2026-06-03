import type { SourceRange } from "../shared/types.js";
export interface SourceIndex {
    source: string;
    bytes: Uint8Array;
    byteToStringOffset: number[];
    lineStartByteOffsets: number[];
    nonWhitespacePrefix: number[];
}
export declare function nonWhitespaceLength(text: string): number;
export declare function rangeForSlice(source: string, byteStart: number, byteEnd: number): SourceRange;
export declare function stableChunkId(filePath: string, byteStart: number, byteEnd: number): string;
export declare function textForByteSlice(source: string, byteStart: number, byteEnd: number): string;
export declare function createSourceIndex(source: string): SourceIndex;
export declare function textForIndexedByteSlice(index: SourceIndex, byteStart: number, byteEnd: number): string;
export declare function rangeForIndexedSlice(index: SourceIndex, byteStart: number, byteEnd: number): SourceRange;
export declare function nonWhitespaceLengthForIndexedSlice(index: SourceIndex, byteStart: number, byteEnd: number): number;
