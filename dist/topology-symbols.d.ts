import type { SyntaxNode } from "./cast.js";
import { type SourceIndex } from "./range.js";
declare function extractSymbolRecords(input: {
    filePath: string;
    source: string;
    sourceIndex?: SourceIndex;
    nodes: SyntaxNode[];
}): {
    childSymbolIds: string[];
    id: string;
    name: string;
    kind: "module" | "class" | "function" | "method" | "interface";
    filePath: string;
    range: import("./types.js").SourceRange;
    parentSymbolId?: string;
}[];
export { extractSymbolRecords };
