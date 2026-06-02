import { Minimatch } from "minimatch";
const GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/;
function matchesPaths(filePath, paths) {
    return compilePathFilters(paths).matches(filePath);
}
function compilePathFilters(paths) {
    if (!paths || paths.length === 0) {
        return { prefixes: [], sqlPrefixes: [], hasGlob: false, matches: () => true };
    }
    const prefixes = paths.filter((filter) => !hasGlobSyntax(filter));
    const globFilters = paths.filter(hasGlobSyntax);
    const globs = globFilters.map((filter) => new Minimatch(filter, { dot: true }));
    return {
        prefixes,
        sqlPrefixes: [...prefixes, ...globFilters.flatMap(staticGlobPrefix)],
        hasGlob: globs.length > 0,
        matches: (filePath) => prefixes.some((filter) => pathPrefixMatches(filePath, filter)) || globs.some((filter) => filter.match(filePath)),
    };
}
function pathPrefixMatches(filePath, filter) {
    return filePath === filter || filePath.startsWith(filter.endsWith("/") ? filter : `${filter}/`);
}
function hasGlobSyntax(filter) {
    return GLOB_SYNTAX_PATTERN.test(filter);
}
function staticGlobPrefix(filter) {
    const firstGlobIndex = filter.search(GLOB_SYNTAX_PATTERN);
    if (firstGlobIndex <= 0) {
        return [];
    }
    const slashIndex = filter.lastIndexOf("/", firstGlobIndex);
    return slashIndex < 0 ? [] : [filter.slice(0, slashIndex + 1)];
}
export { compilePathFilters, matchesPaths };
