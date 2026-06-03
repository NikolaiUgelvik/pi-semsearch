interface CompiledPathFilters {
    prefixes: string[];
    sqlPrefixes: string[];
    hasGlob: boolean;
    matches(filePath: string): boolean;
}
export type { CompiledPathFilters };
