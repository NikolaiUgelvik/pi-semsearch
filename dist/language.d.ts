import type { SyntaxNode } from "./cast.js";
type ParserEntry = {
    id: string;
    extensions: string[];
    filenames?: string[];
    wasm: () => Promise<string>;
};
export declare function languageForPath(filePath: string): ParserEntry | undefined;
export declare function parseSource(filePath: string, source: string): Promise<{
    language: string;
    root: undefined;
} | {
    language: string;
    root: SyntaxNode;
}>;
export {};
