import { describe, expect, test } from "vitest"
import { compilePathFilters, matchesPaths } from "./path-filter.js"

describe("path filters", () => {
  test("matches omitted, exact, directory, and glob filters", () => {
    expect(matchesPaths("src/a.ts", undefined)).toBe(true)
    expect(matchesPaths("src/a.ts", [])).toBe(true)
    expect(matchesPaths("src/a.ts", ["src/a.ts"])).toBe(true)
    expect(matchesPaths("src/a.ts", ["src/"])).toBe(true)
    expect(matchesPaths("src/nested/a.ts", ["src/**/*.ts"])).toBe(true)
    expect(matchesPaths("src/a.ts", ["src/[ab].ts"])).toBe(true)
    expect(matchesPaths("src/c.ts", ["src/[ab].ts"])).toBe(false)
  })

  test("matches glob filters against dot-directories", () => {
    expect(matchesPaths(".github/workflows/ci.yml", ["**/*.yml"])).toBe(true)
  })

  test("matches minimatch brace and extglob filters", () => {
    expect(matchesPaths("src/package.json", ["{src,test}/package.json"])).toBe(true)
    expect(matchesPaths("test/package.json", ["@(src|test)/package.json"])).toBe(true)
    expect(matchesPaths("docs/package.json", ["{src,test}/package.json"])).toBe(false)
    expect(matchesPaths("docs/package.json", ["@(src|test)/package.json"])).toBe(false)
  })

  test("compiled filters preserve raw matching behavior", () => {
    const filters: Array<string[] | undefined> = [
      undefined,
      [],
      ["src/a.ts"],
      ["src/"],
      ["src/**/*.ts"],
      ["src/[ab].ts"],
      ["{src,test}/package.json"],
      ["@(src|test)/package.json"],
      ["src/", "test/**/*.ts"],
    ]
    const paths = ["src/a.ts", "src/nested/a.ts", "src/c.ts", "test/package.json", "docs/package.json"]

    for (const filter of filters) {
      const compiled = compilePathFilters(filter)
      expect(paths.map((filePath) => compiled.matches(filePath))).toEqual(
        paths.map((filePath) => matchesPaths(filePath, filter)),
      )
    }
  })

  test("compiled filters expose prefix and glob metadata", () => {
    const compiled = compilePathFilters(["src/", "test/**/*.ts"])

    expect(compiled.prefixes).toEqual(["src/"])
    expect(compiled.hasGlob).toBe(true)
  })
})
