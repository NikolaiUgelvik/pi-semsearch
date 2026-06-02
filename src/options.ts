import path from "node:path"
import process from "node:process"
import { z } from "zod"
import type { ChunkingOptions, HydeOptions } from "./types.js"

const ApiConfig = z.object({
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string().optional(),
  dimensions: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
})
const EmbeddingConfig = ApiConfig.extend({
  batchSize: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
})
const RerankConfig = ApiConfig.omit({ dimensions: true }).extend({
  candidateMultiplier: z.number().int().positive().optional(),
})

const HybridOptions = z.object({
  enabled: z.boolean().optional(),
  rrfK: z.number().int().positive().optional(),
  vectorCandidateMultiplier: z.number().int().positive().optional(),
  bm25CandidateMultiplier: z.number().int().positive().optional(),
  vectorWeight: z.number().positive().optional(),
  bm25Weight: z.number().positive().optional(),
})
const RetrievalOptions = z.object({
  hybrid: HybridOptions.optional(),
  maxVectorCandidates: z.number().int().positive().optional(),
  maxRerankCandidates: z.number().int().positive().optional(),
})

const ChunkingOptionsSchema = z.object({
  overlap: z.number().int().nonnegative().optional(),
  expansion: z.boolean().optional(),
  minSemanticNonWhitespaceChars: z.number().int().positive().optional(),
})

const OptionsSchema = z.object({
  embedding: EmbeddingConfig.optional(),
  hyde: ApiConfig.extend({
    enabled: z.boolean().optional(),
    threshold: z.number().min(-1).max(1).optional(),
  }).optional(),
  rerank: RerankConfig.optional(),
  retrieval: RetrievalOptions.optional(),
  chunking: ChunkingOptionsSchema.optional(),
  maxChunkNonWhitespaceChars: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxContextChars: z.number().int().positive().optional(),
  topK: z.number().int().positive().optional(),
  cacheDir: z.string().optional(),
  includeGlobs: z.array(z.string()).optional(),
  excludeGlobs: z.array(z.string()).optional(),
})
const OptionsRecord = z.record(z.string(), z.unknown())

const OptionFields = OptionsSchema.shape
const ApiFields = ApiConfig.shape
const EmbeddingFields = OptionFields.embedding.unwrap().shape
const HydeFields = OptionFields.hyde.unwrap().shape
const RerankFields = OptionFields.rerank.unwrap().shape
const HybridFields = RetrievalOptions.shape.hybrid.unwrap().shape
const ChunkingFields = OptionFields.chunking.unwrap().shape
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
const KIB = Number("1024")
const MIB = KIB * KIB
const DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS = 2000
const DEFAULT_MAX_FILE_BYTES = Number("2") * MIB
const DEFAULT_MAX_CONTEXT_CHARS = 12_000
const DEFAULT_TOP_K = 5
const DEFAULT_EMBEDDING_BATCH_SIZE = 16
const DEFAULT_EMBEDDING_CONCURRENCY = 1
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000
const MAX_EMBEDDING_BATCH_SIZE = 2048
const MAX_EMBEDDING_CONCURRENCY = 8
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
const DEFAULT_RESULT_OPTIONS = {
  maxChunkNonWhitespaceChars: DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS,
  maxFileBytes: DEFAULT_SCANNER_OPTIONS.maxFileBytes,
  maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
  topK: DEFAULT_TOP_K,
  includeGlobs: DEFAULT_SCANNER_OPTIONS.includeGlobs,
  excludeGlobs: DEFAULT_SCANNER_OPTIONS.excludeGlobs,
}

export function parseOptions(input: unknown, env: Record<string, string | undefined> = process.env) {
  const inputRecord = parseInputRecord(input)
  const parsed = parseOptionFields(inputRecord.success ? inputRecord.data : {})
  const diagnostics = diagnosticsForOptions(inputRecord, parsed)
  const raw = rawOptions(inputRecord.success ? inputRecord.data : {}, parsed)
  return assembleOptions(raw, diagnostics, env)
}

function parseInputRecord(input: unknown) {
  return OptionsRecord.safeParse(input ?? {})
}

function parseOptionFields(data: Record<string, unknown>) {
  return {
    embedding: OptionFields.embedding.safeParse(data.embedding),
    hyde: OptionFields.hyde.safeParse(data.hyde),
    rerank: OptionFields.rerank.safeParse(data.rerank),
    retrieval: OptionFields.retrieval.safeParse(data.retrieval),
    chunking: OptionFields.chunking.safeParse(data.chunking),
    maxChunkNonWhitespaceChars: OptionFields.maxChunkNonWhitespaceChars.safeParse(data.maxChunkNonWhitespaceChars),
    maxFileBytes: OptionFields.maxFileBytes.safeParse(data.maxFileBytes),
    maxContextChars: OptionFields.maxContextChars.safeParse(data.maxContextChars),
    topK: OptionFields.topK.safeParse(data.topK),
    cacheDir: OptionFields.cacheDir.safeParse(data.cacheDir),
    includeGlobs: OptionFields.includeGlobs.safeParse(data.includeGlobs),
    excludeGlobs: OptionFields.excludeGlobs.safeParse(data.excludeGlobs),
  }
}

function diagnosticsForOptions(
  inputRecord: ReturnType<typeof parseInputRecord>,
  parsed: ReturnType<typeof parseOptionFields>,
) {
  const diagnostics = inputRecord.success
    ? []
    : inputRecord.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  for (const [key, result] of Object.entries(parsed)) {
    if (!result.success) {
      diagnostics.push(...result.error.issues.map((issue) => diagnosticMessage(key, issue)))
    }
  }
  return diagnostics
}

function diagnosticMessage(key: string, issue: z.ZodIssue) {
  return `${[key, ...issue.path].filter(Boolean).join(".")}: ${diagnosticIssueMessage(issue)}`
}

function diagnosticIssueMessage(issue: z.ZodIssue) {
  const details = issue as { code?: string; minimum?: unknown; inclusive?: unknown; origin?: unknown; type?: unknown }
  if (
    details.code === "too_small" &&
    details.minimum === 0 &&
    details.inclusive === false &&
    (details.origin === "number" || details.type === "number")
  ) {
    return "Number must be greater than 0"
  }
  return issue.message
}

function rawOptions(data: Record<string, unknown>, parsed: ReturnType<typeof parseOptionFields>) {
  return {
    embedding: parsedValue(parsed.embedding) ?? parseEmbeddingConfig(data.embedding),
    hyde: parsedValue(parsed.hyde) ?? parseHydeConfig(data.hyde),
    rerank: parsedValue(parsed.rerank) ?? parseRerankConfig(data.rerank),
    retrieval: parsedValue(parsed.retrieval) ?? parseRetrievalOptions(data.retrieval),
    chunking: parsedValue(parsed.chunking) ?? parseChunkingOptions(data.chunking),
    maxChunkNonWhitespaceChars: parsedValue(parsed.maxChunkNonWhitespaceChars),
    maxFileBytes: parsedValue(parsed.maxFileBytes),
    maxContextChars: parsedValue(parsed.maxContextChars),
    topK: parsedValue(parsed.topK),
    cacheDir: parsedValue(parsed.cacheDir),
    includeGlobs: parsedValue(parsed.includeGlobs),
    excludeGlobs: parsedValue(parsed.excludeGlobs),
  }
}

function parsedValue<T>(result: { success: true; data: T } | { success: false }) {
  return result.success ? result.data : undefined
}

function assembleOptions(
  raw: ReturnType<typeof rawOptions>,
  diagnostics: string[],
  env: Record<string, string | undefined>,
) {
  const embedding = embeddingOptions(raw.embedding, apiKeyOption(raw.embedding, env))
  const hyde = hydeOptions(raw.hyde, hasEmbedding(embedding), env)
  addEmbeddingDiagnostics(raw.embedding, diagnostics)

  return {
    embedding,
    hyde,
    rerank: rerankOptions(raw.rerank, apiKeyOption(raw.rerank, env)),
    retrieval: retrievalOptions(raw.retrieval),
    chunking: chunkingOptions(raw.chunking),
    ...resultOptions(raw),
    cacheDir: cacheDirOption(raw.cacheDir, env),
    diagnostics,
  }
}

function apiKeyOption(
  raw: { apiKey?: string; apiKeyEnv?: string } | undefined,
  env: Record<string, string | undefined>,
) {
  return resolveSecret(raw?.apiKey, raw?.apiKeyEnv, env)
}

function hasEmbedding(embedding: ReturnType<typeof embeddingOptions>) {
  return Boolean(embedding)
}

function resultOptions(raw: ReturnType<typeof rawOptions>) {
  return { ...DEFAULT_RESULT_OPTIONS, ...definedProperties(selectResultOptions(raw)) }
}

function selectResultOptions(raw: ReturnType<typeof rawOptions>) {
  return {
    maxChunkNonWhitespaceChars: raw.maxChunkNonWhitespaceChars,
    maxFileBytes: raw.maxFileBytes,
    maxContextChars: raw.maxContextChars,
    topK: raw.topK,
    includeGlobs: raw.includeGlobs,
    excludeGlobs: raw.excludeGlobs,
  }
}

function addEmbeddingDiagnostics(raw: ReturnType<typeof rawOptions>["embedding"], diagnostics: string[]) {
  if (!raw?.baseURL) {
    diagnostics.push("embedding.baseURL is required")
  }
  if (!raw?.model) {
    diagnostics.push("embedding.model is required")
  }
  addMaxDiagnostic("embedding.batchSize", raw?.batchSize, MAX_EMBEDDING_BATCH_SIZE, diagnostics)
  addMaxDiagnostic("embedding.concurrency", raw?.concurrency, MAX_EMBEDDING_CONCURRENCY, diagnostics)
}

function addMaxDiagnostic(key: string, value: number | undefined, max: number, diagnostics: string[]) {
  if (value !== undefined && value > max) {
    diagnostics.push(`${key}: Number must be less than or equal to ${max}`)
  }
}

function withDefault<T>(value: T | undefined, defaultValue: T) {
  return value ?? defaultValue
}

function cacheDirOption(cacheDir: string | undefined, env: Record<string, string | undefined>) {
  return cacheDir ?? env.OPENCODE_CAST_CACHE_DIR ?? path.join(cacheBaseDir(env), "opencode", "cast")
}

function cacheBaseDir(env: Record<string, string | undefined>) {
  return env.XDG_CACHE_HOME ?? path.join(env.HOME ?? process.cwd(), ".cache")
}

function embeddingOptions(raw: ReturnType<typeof rawOptions>["embedding"], apiKey: string | undefined) {
  return raw?.baseURL && raw.model
    ? {
        baseURL: raw.baseURL,
        apiKey,
        model: raw.model,
        dimensions: raw.dimensions,
        batchSize: cappedOption(raw.batchSize, DEFAULT_EMBEDDING_BATCH_SIZE, MAX_EMBEDDING_BATCH_SIZE),
        concurrency: cappedOption(raw.concurrency, DEFAULT_EMBEDDING_CONCURRENCY, MAX_EMBEDDING_CONCURRENCY),
        timeoutMs: raw.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      }
    : undefined
}

function cappedOption(value: number | undefined, defaultValue: number, max: number) {
  return Math.min(value ?? defaultValue, max)
}

function hydeOptions(
  raw: ReturnType<typeof rawOptions>["hyde"],
  hasEmbeddingConfig: boolean,
  env: Record<string, string | undefined>,
): HydeOptions {
  const api = openAiCompatibleConfig(raw)
  return {
    mode: api ? "openai-compatible" : "opencode",
    baseURL: api?.baseURL,
    apiKey: apiKeyForOpenAiHyde(api, raw, env),
    model: api?.model,
    threshold: withDefault(raw?.threshold, DEFAULT_HYDE_THRESHOLD),
    enabled: withDefault(raw?.enabled, hasEmbeddingConfig),
    timeoutMs: raw?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
  }
}

function apiKeyForOpenAiHyde(
  api: { baseURL: string; model: string } | undefined,
  raw: ReturnType<typeof rawOptions>["hyde"],
  env: Record<string, string | undefined>,
) {
  return api ? resolveSecret(raw?.apiKey, raw?.apiKeyEnv, env) : undefined
}

function openAiCompatibleConfig(raw: ReturnType<typeof rawOptions>["hyde"]) {
  return raw?.baseURL && raw.model ? { baseURL: raw.baseURL, model: raw.model } : undefined
}

function rerankOptions(raw: ReturnType<typeof rawOptions>["rerank"], apiKey: string | undefined) {
  return raw?.baseURL && raw.model
    ? {
        baseURL: raw.baseURL,
        apiKey,
        model: raw.model,
        candidateMultiplier: raw.candidateMultiplier ?? DEFAULT_RERANK_CANDIDATE_MULTIPLIER,
        timeoutMs: raw.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      }
    : undefined
}

function hybridOptions(raw: NonNullable<ReturnType<typeof rawOptions>["retrieval"]>["hybrid"]) {
  return { ...DEFAULT_HYBRID_OPTIONS, ...definedProperties(raw) }
}

function retrievalOptions(raw: ReturnType<typeof rawOptions>["retrieval"]) {
  return {
    hybrid: hybridOptions(raw?.hybrid),
    maxVectorCandidates: raw?.maxVectorCandidates ?? DEFAULT_MAX_VECTOR_CANDIDATES,
    maxRerankCandidates: raw?.maxRerankCandidates ?? DEFAULT_MAX_RERANK_CANDIDATES,
  }
}

function chunkingOptions(raw: ReturnType<typeof rawOptions>["chunking"]): ChunkingOptions {
  return { ...DEFAULT_CHUNKING_OPTIONS, ...definedProperties(raw) }
}

function definedProperties<T extends object>(input: T | undefined) {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>
}

function resolveSecret(
  value: string | undefined,
  envName: string | undefined,
  env: Record<string, string | undefined>,
) {
  return value ?? (envName ? env[envName] : undefined)
}

function parseApiConfig(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  return {
    baseURL: safeField(ApiFields.baseURL, inputRecord.data.baseURL),
    apiKey: safeField(ApiFields.apiKey, inputRecord.data.apiKey),
    apiKeyEnv: safeField(ApiFields.apiKeyEnv, inputRecord.data.apiKeyEnv),
    model: safeField(ApiFields.model, inputRecord.data.model),
    dimensions: safeField(ApiFields.dimensions, inputRecord.data.dimensions),
    timeoutMs: safeField(ApiFields.timeoutMs, inputRecord.data.timeoutMs),
  }
}

function parseEmbeddingConfig(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  const api = parseApiConfig(input)
  return {
    ...api,
    batchSize: safeField(EmbeddingFields.batchSize, inputRecord.data.batchSize),
    concurrency: safeField(EmbeddingFields.concurrency, inputRecord.data.concurrency),
  }
}

function parseHydeConfig(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  const api = parseApiConfig(input)
  return {
    ...api,
    enabled: safeField(HydeFields.enabled, inputRecord.data.enabled),
    threshold: safeField(HydeFields.threshold, inputRecord.data.threshold),
  }
}

function parseRerankConfig(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  const api = parseApiConfig(input)
  return {
    baseURL: api?.baseURL,
    apiKey: api?.apiKey,
    apiKeyEnv: api?.apiKeyEnv,
    model: api?.model,
    timeoutMs: api?.timeoutMs,
    candidateMultiplier: safeField(RerankFields.candidateMultiplier, inputRecord.data.candidateMultiplier),
  }
}

function parseRetrievalOptions(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  return {
    hybrid: parseHybridOptions(inputRecord.data.hybrid),
    maxVectorCandidates: safeField(RetrievalOptions.shape.maxVectorCandidates, inputRecord.data.maxVectorCandidates),
    maxRerankCandidates: safeField(RetrievalOptions.shape.maxRerankCandidates, inputRecord.data.maxRerankCandidates),
  }
}

function parseChunkingOptions(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  return {
    overlap: safeField(ChunkingFields.overlap, inputRecord.data.overlap),
    expansion: safeField(ChunkingFields.expansion, inputRecord.data.expansion),
    minSemanticNonWhitespaceChars: safeField(
      ChunkingFields.minSemanticNonWhitespaceChars,
      inputRecord.data.minSemanticNonWhitespaceChars,
    ),
  }
}

function parseHybridOptions(input: unknown) {
  const inputRecord = OptionsRecord.safeParse(input ?? {})
  if (!inputRecord.success) {
    return
  }

  return {
    enabled: safeField(HybridFields.enabled, inputRecord.data.enabled),
    rrfK: safeField(HybridFields.rrfK, inputRecord.data.rrfK),
    vectorCandidateMultiplier: safeField(
      HybridFields.vectorCandidateMultiplier,
      inputRecord.data.vectorCandidateMultiplier,
    ),
    bm25CandidateMultiplier: safeField(HybridFields.bm25CandidateMultiplier, inputRecord.data.bm25CandidateMultiplier),
    vectorWeight: safeField(HybridFields.vectorWeight, inputRecord.data.vectorWeight),
    bm25Weight: safeField(HybridFields.bm25Weight, inputRecord.data.bm25Weight),
  }
}

function safeField<T>(schema: z.ZodType<T>, input: unknown) {
  const parsed = schema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}
