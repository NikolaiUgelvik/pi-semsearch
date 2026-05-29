# opencode-plugin-cast

Unofficial cAST semantic code search plugin for opencode. Code Retrieval-Augmented Generation with structural chunking via abstract syntax tree.

This is an unofficial community plugin. It is not affiliated with, endorsed by, sponsored by, or maintained by opencode, opencode.ai, or the `@opencode-ai` npm organization. It depends on `@opencode-ai/plugin` only for the public plugin API.

The plugin registers `semantic_search_code`, a repository search tool that chunks code with Tree-sitter AST structure where supported, falls back to deterministic text chunks where unsupported, embeds chunks through an OpenAI-compatible endpoint, and expands matches with enclosing class/function context when it fits the response budget.

## Installation

Add the plugin to your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-plugin-cast",
      {
        "embedding": {
          "baseURL": "https://api.openai.com/v1",
          "apiKeyEnv": "OPENAI_API_KEY",
          "model": "text-embedding-3-small"
        },
        "hyde": {
          "model": "gpt-4o-mini",
          "threshold": 0.35
        }
      }
    ]
  ]
}
```

Restart opencode after changing plugin configuration. Plugins are loaded when opencode starts and are not hot-reloaded.

## OpenAI-Compatible Providers

`embedding.baseURL` must point at an OpenAI-compatible API root. `embedding.model` is required. Provide credentials with either `embedding.apiKey` or `embedding.apiKeyEnv`.

```json
{
  "embedding": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

`dimensions` is optional and is forwarded to providers that support embedding dimension selection.

## OpenRouter HyDE Example

OpenRouter can be used as the HyDE chat provider while embeddings come from a verified OpenAI-compatible embeddings provider. `embedding.baseURL` must point to a provider and model that supports the OpenAI-compatible embeddings endpoint; only use OpenRouter for embeddings if you have verified the selected OpenRouter model supports embeddings.

```json
{
  "plugin": [
    [
      "opencode-plugin-cast",
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
    ]
  ]
}
```

## Tool

`semantic_search_code` inputs:

- `query`: natural-language repository search query.
- `topK`: optional number of final results. Defaults to `5`.
- `maxContextChars`: optional context budget. Defaults to `12000`.
- `includeParents`: optional parent context toggle. Defaults to `true`.
- `refresh`: optional forced index refresh before searching.
- `paths`: optional path filters. Entries can be exact file paths or directory prefixes.

The tool returns a JSON payload with ranked results, diagnostics, and retrieval status metadata. When embedding config is missing or invalid, opencode still starts and the tool returns a clear configuration error.

## Cache

The index is stored outside the repository. The default cache directory is `${XDG_CACHE_HOME:-~/.cache}/opencode/cast`.

Override the cache location with plugin config:

```json
{
  "cacheDir": "/absolute/path/to/cache"
}
```

Or with an environment variable:

```bash
export OPENCODE_CAST_CACHE_DIR=/absolute/path/to/cache
```

The cache key includes the opencode project id, worktree path, embedding model settings, and chunk-size setting.

## Language Coverage

The bundled grammar set targets TypeScript/TSX, JavaScript/JSX, Python, Go, Rust, Java, Ruby, and Bash. Files without a supported parser are indexed with fallback text chunks.

## HyDE

The plugin runs normal embedding search first. If the best similarity is below `hyde.threshold`, it asks the configured chat model to produce a concise hypothetical code-search target, embeds that text, and reranks candidates.

HyDE is enabled by default when `hyde.model` is configured. Set `hyde.enabled` to `false` to disable it:

```json
{
  "hyde": {
    "enabled": false
  }
}
```

HyDE defaults to the embedding provider base URL and API key when `hyde.baseURL`, `hyde.apiKey`, and `hyde.apiKeyEnv` are omitted. HyDE failures fall back to normal embedding results.

## Local Development

Install dependencies, run tests, typecheck, and build:

```bash
npm_config_nodedir=/usr npm exec --yes bun@1.3.14 -- install
npm exec --yes bun@1.3.14 -- test --timeout 30000
npm exec --yes bun@1.3.14 -- run typecheck
npm exec --yes bun@1.3.14 -- run build
```

To test a local build in opencode, point config at the built file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/opencode-plugin-cast/dist/index.js",
      {
        "embedding": {
          "baseURL": "https://api.openai.com/v1",
          "apiKeyEnv": "OPENAI_API_KEY",
          "model": "text-embedding-3-small"
        }
      }
    ]
  ]
}
```

Restart opencode after rebuilding the plugin or changing plugin config. The package root intentionally exports only the default plugin function so opencode does not confuse internal helper functions for plugin exports.

## Acknowledgements

This implementation is based on ideas from:

Zhang et al., “cAST: Enhancing Code Retrieval-Augmented Generation with Structural Chunking via Abstract Syntax Tree,” arXiv:2506.15655, 2025.  
https://arxiv.org/abs/2506.15655

This repository is an independent implementation and is not affiliated with the original authors.
