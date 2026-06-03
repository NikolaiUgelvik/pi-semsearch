import type { CompiledPathFilters } from "./path-filter-types.js";
declare function sqlitePrefixPathFilter(pathFilters: CompiledPathFilters): {
    sql: string;
    args: string[];
};
export { sqlitePrefixPathFilter };
