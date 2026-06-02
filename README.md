# pi-semsearch

Semantic code search extension for [Pi](https://github.com/Earendil-Works/pi) using syntax-aware structural chunking and OpenAI-compatible embeddings.

The extension registers two Pi tools:

- `semantic_search_code` — ranked semantic repository search with syntax-aware chunks, breadcrumbs, file/line ranges, and topology IDs.
- `semantic_get_chunk` — fetch an exact chunk by ID and optionally include parents, siblings, and children.

## Installation

From a local checkout while developing:

```bash
pi -e /home/nikolai/git/pi-semsearch
```

Or install as a Pi package:

```bash
pi install /home/nikolai/git/pi-semsearch
# or, once pushed:
pi install git:github.com/NikolaiUgelvik/pi-semsearch
```

## Configuration

Create `.pi/semsearch.json` in the project root, `semsearch.pi.json` in the project root, or `~/.pi/semsearch.json`:

```json
{
  "embedding": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  },
  "hyde": {
    "enabled": false
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

HyDE is disabled by default for Pi unless configured with an OpenAI-compatible chat provider:

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

## Commands

- `/semsearch-refresh` — force-refresh the pi-semsearch index for the current project.

## Notes

Runtime code uses Pi's extension API (`pi.registerTool`, `pi.registerCommand`, and lifecycle events) and Node file APIs so it can run under Pi's extension loader.
