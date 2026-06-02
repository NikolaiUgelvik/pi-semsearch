# AGENTS.md

## Commands

- Use Bun `1.3.14`; the README uses `npm exec --yes bun@1.3.14 -- <cmd>` when the local Bun version is not guaranteed.
- Install deps with `npm_config_nodedir=/usr npm exec --yes bun@1.3.14 -- install`; Tree-sitter deps are trusted in `package.json`.
- Full verification before packaging: `bun run check && bun run typecheck && bun run build`; `prepack` runs exactly that order.
- Usual local verification: `bun run lint`, `bun run typecheck`, `bun test --timeout 30000`, `bun run build`.
- Focused test: `bun test --timeout 30000 src/options.test.ts` or add `-t "test name"`.
- `bun run format` is the only mutating formatter command; `lint`/`check` are non-mutating Biome checks.

## Architecture

- This is a single-package ESM TypeScript Pi extension; `src/index.ts` intentionally exports only the default extension from `src/extension.ts` so Pi loads only the extension entrypoint.
- `src/extension.ts` registers one tool, `semantic_search_code`, starts background indexing when embedding config is valid, and serializes forced refreshes.
- Indexing flow: `scanner.ts` walks the worktree, skips `.git`, `node_modules`, `dist`, `build`, `.cache`, parses supported languages with Tree-sitter via `language.ts`, falls back to text chunks, embeds chunks, and writes the cache through `store.ts`.
- Retrieval flow: `retriever.ts` embeds the query, searches cached vectors, optionally runs HyDE when the best score is below threshold, and expands parent context from source when possible.
- Extension options are parsed in `options.ts`; missing or invalid embedding config must not break Pi startup, it should surface diagnostics from the tool.
- Default cache is outside the repo at `${XDG_CACHE_HOME:-~/.cache}/pi/semsearch`; `PI_SEMSEARCH_CACHE_DIR` or `cacheDir` override it.

## Style And Build Gotchas

- TypeScript builds with `tsc` to `dist/`; tests are excluded from `tsconfig.json` build input.
- Imports in source use `.js` extensions because `module`/`moduleResolution` are `nodenext`.
- Biome is strict: 2-space indentation, double quotes, no semicolons, trailing commas, line width 120; prefer small targeted rule overrides only when a rule conflicts with a valid Bun/Pi pattern.
- Keep Pi config examples as extension entries; after changing extension config or rebuilding a local `dist/index.js`, Pi must be restarted if the extension is already loaded.
