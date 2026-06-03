function pathPrefixMatches(filePath, filter) {
    return filePath === filter || filePath.startsWith(filter.endsWith("/") ? filter : `${filter}/`);
}
export { pathPrefixMatches };
