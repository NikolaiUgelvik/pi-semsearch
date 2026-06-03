import type { ChunkLookupOutput, SearchOutput } from "./types.js";
interface ToolOutputLimits {
    maxLines?: number;
    maxBytes?: number;
}
declare function unavailableToolResult(title: string, message: string | undefined): {
    title: string;
    output: string;
    metadata: {
        configured: boolean;
        available: boolean;
    };
};
declare function serializeSearchToolOutput(output: SearchOutput, limits?: ToolOutputLimits): string;
declare function serializeChunkLookupToolOutput(output: ChunkLookupOutput, limits?: ToolOutputLimits): string;
export type { ToolOutputLimits };
export { serializeChunkLookupToolOutput, serializeSearchToolOutput, unavailableToolResult };
