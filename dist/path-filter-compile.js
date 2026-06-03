import { globMatchers, hasGlobSyntax, staticGlobPrefix } from "./path-filter-glob.js";
import { pathPrefixMatches } from "./path-filter-prefix.js";
function compilePathFilters(paths) {
    if (!paths || paths.length === 0) {
        return { prefixes: [], sqlPrefixes: [], hasGlob: false, matches: () => true };
    }
    const prefixes = paths.filter((filter) => !hasGlobSyntax(filter));
    const globFilters = paths.filter(hasGlobSyntax);
    const globs = globMatchers(globFilters);
    return {
        prefixes,
        sqlPrefixes: [...prefixes, ...globFilters.flatMap(staticGlobPrefix)],
        hasGlob: globs.length > 0,
        matches: (filePath) => prefixes.some((filter) => pathPrefixMatches(filePath, filter)) || globs.some((filter) => filter.match(filePath)),
    };
}
export { compilePathFilters };
