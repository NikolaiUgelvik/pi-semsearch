import type { ChunkingOptions } from "./types.js"

const KIB = Number("1024")
const MIB = KIB * KIB
const DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS = 2000
const DEFAULT_MAX_FILE_BYTES = Number("2") * MIB
const DEFAULT_MAX_CONTEXT_CHARS = 12_000
const DEFAULT_TOP_K = 5
const DEFAULT_EXCLUDE_GLOBS = [
  "**/*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,gz,tgz,tar,7z,mp4,mov,mp3,woff,woff2,ttf,eot}",
  "**/bun.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.min.js",
  "**/*.map",
  "**/__pycache__/**",
  "**/*.{pyc,pyo,pyd}",
  "**/.venv/**",
  "**/venv/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/.nox/**",
  "**/*.egg-info/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.vite/**",
  "**/.parcel-cache/**",
  "**/*.test",
  "**/coverage.out",
  "**/target/**",
  "**/.gradle/**",
  "**/*.{class,jar,war,ear}",
  "**/.bundle/**",
  "**/vendor/bundle/**",
  "**/vendor/**",
]
const DEFAULT_SCANNER_OPTIONS = {
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  includeGlobs: ["**/*"],
  excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
}

const DEFAULT_HYDE_THRESHOLD = 0.35
const DEFAULT_RERANK_CANDIDATE_MULTIPLIER = 4
const DEFAULT_HYBRID_OPTIONS = {
  enabled: true,
  rrfK: 60,
  vectorCandidateMultiplier: 8,
  bm25CandidateMultiplier: 8,
  vectorWeight: 1,
  bm25Weight: 1,
}
const DEFAULT_MAX_VECTOR_CANDIDATES = 512
const DEFAULT_MAX_RERANK_CANDIDATES = 64
const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  overlap: 0,
  expansion: false,
  minSemanticNonWhitespaceChars: 8,
}
const DEFAULT_EMBEDDING_BATCH_SIZE = 16
const DEFAULT_EMBEDDING_CONCURRENCY = 1
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000
const MAX_EMBEDDING_BATCH_SIZE = 2048
const MAX_EMBEDDING_CONCURRENCY = 8
const DEFAULT_RESULT_OPTIONS = {
  maxChunkNonWhitespaceChars: DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS,
  maxFileBytes: DEFAULT_SCANNER_OPTIONS.maxFileBytes,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
  topK: DEFAULT_TOP_K,
  includeGlobs: DEFAULT_SCANNER_OPTIONS.includeGlobs,
  excludeGlobs: DEFAULT_SCANNER_OPTIONS.excludeGlobs,
}

export {
  DEFAULT_CHUNKING_OPTIONS,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_CONCURRENCY,
  DEFAULT_HYBRID_OPTIONS,
  DEFAULT_HYDE_THRESHOLD,
  DEFAULT_MAX_RERANK_CANDIDATES,
  DEFAULT_MAX_VECTOR_CANDIDATES,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_RERANK_CANDIDATE_MULTIPLIER,
  DEFAULT_RESULT_OPTIONS,
  MAX_EMBEDDING_BATCH_SIZE,
  MAX_EMBEDDING_CONCURRENCY,
}
