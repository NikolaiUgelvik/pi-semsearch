import { minimatch } from "minimatch"

const GLOB_SYNTAX_PATTERN = /[*?[{]|[!+@]\(/

function matchesPaths(filePath: string, paths: string[] | undefined) {
  if (!paths || paths.length === 0) {
    return true
  }
  return paths.some((filter) => pathFilterMatches(filePath, filter))
}

function pathFilterMatches(filePath: string, filter: string) {
  return hasGlobSyntax(filter) ? minimatch(filePath, filter, { dot: true }) : pathPrefixMatches(filePath, filter)
}

function pathPrefixMatches(filePath: string, filter: string) {
  return filePath === filter || filePath.startsWith(filter.endsWith("/") ? filter : `${filter}/`)
}

function hasGlobSyntax(filter: string) {
  return GLOB_SYNTAX_PATTERN.test(filter)
}

export { matchesPaths }
