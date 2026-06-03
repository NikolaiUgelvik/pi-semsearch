import { realpath } from "node:fs/promises"
import path from "node:path"

function worktreeRelativePath(worktree: string, filePath: string) {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, filePath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return
  }
  return relative
}

async function resolveWorktreePath(worktree: string, filePath: string) {
  const root = path.resolve(worktree)
  const resolved = path.resolve(root, filePath)
  const relative = path.relative(root, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`source path escapes worktree: ${filePath}`)
  }
  const realRoot = await realpath(root)
  const realResolved = await realpath(resolved)
  const realRelative = path.relative(realRoot, realResolved)
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`source path escapes worktree: ${filePath}`)
  }
  return resolved
}

export { resolveWorktreePath, worktreeRelativePath }
