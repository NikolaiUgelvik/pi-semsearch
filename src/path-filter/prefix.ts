function pathPrefixMatches(filePath: string, filter: string) {
  return filePath === filter || filePath.startsWith(filter.endsWith("/") ? filter : `${filter}/`)
}

export { pathPrefixMatches }
