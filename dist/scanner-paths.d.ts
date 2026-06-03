import type { CreateIndexerInput } from "./scanner-types.js";
declare function shouldIndexSingleFile(input: CreateIndexerInput, relativePath: string): Promise<boolean>;
declare function worktreeRelativePath(worktree: string, filePath: string): string | undefined;
declare function scanFiles(root: string, includeGlobs: string[], excludeGlobs: string[]): AsyncGenerator<string, void, unknown>;
export { scanFiles, shouldIndexSingleFile, worktreeRelativePath };
