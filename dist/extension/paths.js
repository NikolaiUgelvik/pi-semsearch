import { realpath } from "node:fs/promises";
import path from "node:path";
function worktreeRelativePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, normalizeToolPath(filePath));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return;
    }
    return relative;
}
async function resolveWorktreePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, normalizeToolPath(filePath));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`source path escapes worktree: ${filePath}`);
    }
    const realRoot = await realpath(root);
    const realResolved = await realpath(resolved);
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`source path escapes worktree: ${filePath}`);
    }
    return resolved;
}
function normalizeToolPath(filePath) {
    return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}
export { resolveWorktreePath, worktreeRelativePath };
