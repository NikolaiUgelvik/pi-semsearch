import { minimatch } from "minimatch";
const GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/;
function matchesPaths(filePath, paths) {
    if (!paths || paths.length === 0) {
        return true;
    }
    return paths.some((filter) => pathFilterMatches(filePath, filter));
}
function pathFilterMatches(filePath, filter) {
    return hasGlobSyntax(filter) ? minimatch(filePath, filter, { dot: true }) : pathPrefixMatches(filePath, filter);
}
function pathPrefixMatches(filePath, filter) {
    return filePath === filter || filePath.startsWith(filter.endsWith("/") ? filter : `${filter}/`);
}
function hasGlobSyntax(filter) {
    return GLOB_SYNTAX_PATTERN.test(filter);
}
export { matchesPaths };
