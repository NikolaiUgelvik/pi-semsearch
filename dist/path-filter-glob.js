import { Minimatch } from "minimatch";
const GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/;
function globMatchers(filters) {
    return filters.map((filter) => new Minimatch(filter, { dot: true }));
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
export { globMatchers, hasGlobSyntax, staticGlobPrefix };
