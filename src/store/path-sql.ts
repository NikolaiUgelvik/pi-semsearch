import type { CompiledPathFilters } from "../path-filter/types.js"

function sqlitePrefixPathFilter(pathFilters: CompiledPathFilters) {
  const prefixes = sqlPathPrefixes(pathFilters)
  if (prefixes.length === 0) {
    return { sql: "", args: [] as string[] }
  }

  const clauses: string[] = []
  const args: string[] = []
  for (const filter of prefixes) {
    const prefix = filter.endsWith("/") ? filter : `${filter}/`
    clauses.push("(chunks.file_path = ? or chunks.file_path like ? escape '\\')")
    args.push(filter, `${escapeSqlLike(prefix)}%`)
  }

  return { sql: ` and (${clauses.join(" or ")})`, args }
}

function sqlPathPrefixes(pathFilters: CompiledPathFilters) {
  return [...new Set(pathFilters.sqlPrefixes.filter((prefix) => prefix.length > 0))]
}

function escapeSqlLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

export { sqlitePrefixPathFilter }
