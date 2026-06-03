import type { CastIndex, ChunkLookupInput, ChunkLookupOutput } from "../shared/types.js";
declare function getChunkById(input: {
    index: CastIndex;
    input: ChunkLookupInput;
    readSource(filePath: string): Promise<string>;
}): Promise<ChunkLookupOutput>;
export { getChunkById };
