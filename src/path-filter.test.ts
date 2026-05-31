import { describe, expect, test } from "bun:test"
import { matchesPaths } from "./path-filter.js"

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
})
