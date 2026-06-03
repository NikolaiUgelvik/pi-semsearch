import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { Minimatch } from "minimatch";
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".cache"]);
const TRAILING_SLASHES = /\/+$/;
async function shouldIndexSingleFile(input, relativePath) {
    const predicates = createScanPredicates(input.options.includeGlobs, input.options.excludeGlobs);
    return (predicates.includes(relativePath) &&
        !predicates.excludes(relativePath) &&
        !hasExcludedDirectoryAncestor(relativePath, predicates) &&
        !hasDefaultIgnoredPathPart(relativePath) &&
        !(await hasSymlinkPathComponent(input.worktree, relativePath)) &&
        !(await isGitignoredPath(input.worktree, relativePath)));
}
function hasExcludedDirectoryAncestor(relativePath, predicates) {
    return ancestorDirectories(relativePath).some((directory) => predicates.excludesDirectory(directory));
}
function ancestorDirectories(relativePath) {
    const dirname = path.dirname(relativePath);
    if (dirname === ".") {
        return [];
    }
    const segments = dirname.split(path.sep);
    return segments.map((_, index) => segments.slice(0, index + 1).join(path.sep));
}
async function hasSymlinkPathComponent(root, relativePath) {
    for (const componentPath of pathComponentPaths(relativePath)) {
        if (await isSymlinkPath(root, componentPath)) {
            return true;
        }
    }
    return false;
}
function pathComponentPaths(relativePath) {
    const parts = relativePath.split(path.sep).filter(Boolean);
    return parts.map((_, index) => parts.slice(0, index + 1).join(path.sep));
}
async function isSymlinkPath(root, relativePath) {
    try {
        return (await lstat(path.join(root, relativePath))).isSymbolicLink();
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
function hasDefaultIgnoredPathPart(relativePath) {
    return relativePath.split(path.sep).some((part) => DEFAULT_IGNORED_DIRECTORIES.has(part));
}
async function isGitignoredPath(root, relativePath) {
    const gitignores = [];
    const dirname = path.dirname(relativePath);
    const segments = dirname === "." ? [] : dirname.split(path.sep);
    for (let index = 0; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join(path.sep);
        const localGitignore = await loadGitignore(root, prefix);
        if (localGitignore) {
            gitignores.push(localGitignore);
        }
    }
    return isGitignored(relativePath, gitignores);
}
function worktreeRelativePath(worktree, filePath) {
    const root = path.resolve(worktree);
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return;
    }
    return relative;
}
async function* scanFiles(root, includeGlobs, excludeGlobs) {
    const predicates = createScanPredicates(includeGlobs, excludeGlobs);
    for await (const file of walk(root, predicates)) {
        if (predicates.includes(file) && !predicates.excludes(file)) {
            yield file;
        }
    }
}
function createScanPredicates(includeGlobs, excludeGlobs) {
    const includes = includeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }));
    const excludes = excludeGlobs.map((pattern) => new Minimatch(pattern, { dot: true }));
    const directoryExcludes = excludeGlobs
        .filter((pattern) => canPruneDirectoryForExclude(pattern))
        .map((pattern) => new Minimatch(pattern, { dot: true }));
    return {
        includes: (filePath) => includes.some((matcher) => matcher.match(filePath)),
        excludes: (filePath) => excludes.some((matcher) => matcher.match(filePath)),
        excludesDirectory: (relativePath) => {
            const globPath = toGitignorePath(relativePath);
            return directoryExcludes.some((matcher) => matcher.match(globPath) || matcher.match(`${globPath}/`));
        },
    };
}
function canPruneDirectoryForExclude(pattern) {
    const normalizedPattern = pattern.replaceAll("\\", "/").replace(TRAILING_SLASHES, "");
    if (normalizedPattern.endsWith("/**")) {
        return true;
    }
    return !new Minimatch(pattern, { dot: true }).hasMagic();
}
async function loadGitignore(root, prefix) {
    const matcher = ignore();
    try {
        matcher.add(await readFile(path.join(root, prefix, ".gitignore"), "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
        return;
    }
    return { base: prefix, matcher };
}
async function* walk(root, predicates) {
    const queue = [{ prefix: "", gitignores: [] }];
    while (queue.length > 0) {
        const directory = queue.shift();
        if (!directory) {
            continue;
        }
        for (const entry of await walkEntries(root, directory)) {
            const relative = path.join(directory.prefix, entry.name);
            if (shouldSkipWalkEntry(entry, relative, entry.gitignores)) {
                continue;
            }
            if (entry.isDirectory()) {
                enqueueWalkDirectory(queue, relative, entry.gitignores, predicates);
                continue;
            }
            yield relative;
        }
    }
}
async function walkEntries(root, directory) {
    const entries = await readdir(path.join(root, directory.prefix), { withFileTypes: true });
    const localGitignore = await loadGitignore(root, directory.prefix);
    const gitignores = localGitignore ? [...directory.gitignores, localGitignore] : directory.gitignores;
    return entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => Object.assign(entry, { gitignores }));
}
function shouldSkipWalkEntry(entry, relative, gitignores) {
    return DEFAULT_IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink() || isGitignored(relative, gitignores);
}
function enqueueWalkDirectory(queue, relative, gitignores, predicates) {
    if (!predicates.excludesDirectory(relative)) {
        queue.push({ prefix: relative, gitignores });
    }
}
function isGitignored(relativePath, gitignores) {
    return gitignores.some(({ base, matcher }) => {
        const relativeToBase = base ? path.relative(base, relativePath) : relativePath;
        return relativeToBase && !relativeToBase.startsWith("..") && !path.isAbsolute(relativeToBase)
            ? matcher.ignores(toGitignorePath(relativeToBase))
            : false;
    });
}
function toGitignorePath(relativePath) {
    return relativePath.split(path.sep).join("/");
}
export { scanFiles, shouldIndexSingleFile, worktreeRelativePath };
