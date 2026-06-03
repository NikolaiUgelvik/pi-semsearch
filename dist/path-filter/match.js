import { globMatchers, hasGlobSyntax } from "./glob.js";
import { pathPrefixMatches } from "./prefix.js";
function matchesPaths(filePath, paths) {
    if (!paths || paths.length === 0) {
        return true;
    }
    const prefixes = paths.filter((filter) => !hasGlobSyntax(filter));
    const globs = globMatchers(paths.filter(hasGlobSyntax));
    return (prefixes.some((filter) => pathPrefixMatches(filePath, filter)) || globs.some((filter) => filter.match(filePath)));
}
export { matchesPaths };
