# pi-semsearch

Semantic code search extension for [Pi](https://github.com/Earendil-Works/pi) using syntax-aware structural chunking and OpenAI-compatible embeddings.

The extension registers two Pi tools:

- `semantic_search_code` — ranked semantic repository search with syntax-aware chunks, breadcrumbs, file/line ranges, and topology context. Results expose the matched unit as `topology.current`.
- `semantic_get_chunk` — fetch exact context for a code chunk identified by any topology node ID from `semantic_search_code`, optionally including parents, siblings, and children.

## How it works

pi-semsearch maintains a local SQLite index per worktree/configuration.

At index time, it scans the repository, parses supported languages with native Tree-sitter grammars, splits source into structural chunks, embeds those chunks with the configured embedding provider, and stores metadata plus vectors in `index.sqlite` using `sqlite-vec`.

At query time, it runs hybrid retrieval: vector search for semantic similarity, SQLite FTS/BM25 for lexical matches, and Reciprocal Rank Fusion (RRF) to merge the candidate lists. If the initial vector match is weak, HyDE uses Pi's active model to generate alternative search text, embeds that text, and merges those candidates into retrieval. Optional reranking can reorder the final candidate set.

Search results include source text, file/line ranges, symbol breadcrumbs, and structural topology. `semantic_get_chunk` can then hydrate any topology node by ID, such as `topology.current.id`, `topology.parent.id`, a sibling ID, or a child ID.

Retrieval scores and debug details are hidden from `semantic_search_code` output by default. Set `PI_SEMSEARCH_DEBUG_RETRIEVAL=1` to expose `score`, `finalScore`, `retrieval`, and `status.bestScore` while debugging.

## Installation

Install from GitHub as a Pi package:

```bash
pi install git:github.com/NikolaiUgelvik/pi-semsearch
```

Or use a local checkout while developing:

```bash
pi install /path/to/pi-semsearch
```

After changing extension code in a local checkout, reload Pi with `/reload`. If dependencies or `package.json` changed, restart Pi or reinstall/update the package.

## Configuration

Create `.pi/semsearch.json` in the project root, `semsearch.pi.json` in the project root, or `~/.pi/semsearch.json` for global defaults:

```json
{
  "embedding": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "hyde": {
    "threshold": 0.35
  }
}
```

You can also set `PI_SEMSEARCH_CONFIG=/path/to/semsearch.json`.

Minimal environment-based configuration is supported:

```bash
export OPENAI_API_KEY=...
export PI_SEMSEARCH_EMBEDDING_MODEL=text-embedding-3-small
# optional; defaults to https://api.openai.com/v1
export PI_SEMSEARCH_EMBEDDING_BASE_URL=https://api.openai.com/v1
```

HyDE is enabled by default when embeddings are configured, and uses Pi's active model for query expansion. Disable it with `"hyde": { "enabled": false }`. You can also pin HyDE to an explicit OpenAI-compatible chat provider:

```json
{
  "embedding": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "text-embedding-3-small"
  },
  "hyde": {
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "model": "openai/gpt-4o-mini",
    "threshold": 0.35
  }
}
```

## Cache and database location

Indexes are stored as SQLite databases outside the repository by default:

```text
${XDG_CACHE_HOME:-~/.cache}/pi/semsearch/<cache-key>/index.sqlite
```

Override the cache root with either:

```json
{
  "cacheDir": "/some/path"
}
```

or:

```bash
export PI_SEMSEARCH_CACHE_DIR=/some/path
```

## Commands

- `/semsearch-refresh` — force-refresh the pi-semsearch index for the current project.

## Development

Use Node `24.x` and npm `11.x`:

```bash
npm install
npm run check
npm run typecheck
npm test
npm run build
```

On Node 24, if native `tree-sitter` builds from source, use:

```bash
CXXFLAGS='-std=c++20' npm install
```

The package uses native Tree-sitter grammar bindings, `better-sqlite3`, `sqlite-vec`, and Vitest for tests.

## Notes

The Pi package manifest loads extensions from `extensions/`; `extensions/pi-semsearch.ts` delegates to the implementation in `src/`. Runtime code uses Pi's extension API (`pi.registerTool`, `pi.registerCommand`, and lifecycle events) and Node file APIs so it can run under Pi's extension loader.
