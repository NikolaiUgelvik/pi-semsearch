interface CompiledPathFilters {
    prefixes: string[];
    sqlPrefixes: string[];
    hasGlob: boolean;
    matches(filePath: string): boolean;
}
declare function matchesPaths(filePath: string, paths: string[] | undefined): boolean;
declare function compilePathFilters(paths?: string[]): CompiledPathFilters;
export { type CompiledPathFilters, compilePathFilters, matchesPaths };
