import { Minimatch } from "minimatch";
declare function globMatchers(filters: string[]): Minimatch[];
declare function hasGlobSyntax(filter: string): boolean;
declare function staticGlobPrefix(filter: string): string[];
export { globMatchers, hasGlobSyntax, staticGlobPrefix };
