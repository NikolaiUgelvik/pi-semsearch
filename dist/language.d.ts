import Parser from "tree-sitter";
import type { SyntaxNode } from "./cast.js";
type NativeLanguage = Parameters<Parser["setLanguage"]>[0];
type ParserEntry = {
    id: string;
    extensions: string[];
    filenames?: string[];
    language: NativeLanguage;
};
export declare function languageForPath(filePath: string): ParserEntry | undefined;
export declare function parseSource(filePath: string, source: string): Promise<{
    language: string;
    root: undefined;
}> | Promise<{
    language: string;
    root: SyntaxNode;
}>;
export {};
