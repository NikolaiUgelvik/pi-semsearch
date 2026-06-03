declare function worktreeRelativePath(worktree: string, filePath: string): string | undefined;
declare function resolveWorktreePath(worktree: string, filePath: string): Promise<string>;
export { resolveWorktreePath, worktreeRelativePath };
