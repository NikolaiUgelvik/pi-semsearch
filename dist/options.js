import path from "node:path";
import process from "node:process";
import { z } from "zod";
const ApiConfig = z.object({
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    model: z.string().optional(),
    dimensions: z.number().int().positive().optional(),
});
const RerankConfig = ApiConfig.omit({ dimensions: true }).extend({
    candidateMultiplier: z.number().int().positive().optional(),
});
const HybridMode = z.enum(["parallel", "bm25-prefilter", "vector-prefilter"]);
const HybridOptions = z.object({
    enabled: z.boolean().optional(),
    mode: HybridMode.optional(),
    rrfK: z.number().int().positive().optional(),
    vectorCandidateMultiplier: z.number().int().positive().optional(),
    bm25CandidateMultiplier: z.number().int().positive().optional(),
    vectorWeight: z.number().positive().optional(),
    bm25Weight: z.number().positive().optional(),
});
const RetrievalOptions = z.object({
    hybrid: HybridOptions.optional(),
});
const ChunkingOptionsSchema = z.object({
    overlap: z.number().int().nonnegative().optional(),
    expansion: z.boolean().optional(),
    minSemanticNonWhitespaceChars: z.number().int().positive().optional(),
});
const OptionsSchema = z.object({
    embedding: ApiConfig.optional(),
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
});
const OptionsRecord = z.record(z.string(), z.unknown());
const OptionFields = OptionsSchema.shape;
const ApiFields = ApiConfig.shape;
const HydeFields = OptionFields.hyde.unwrap().shape;
const RerankFields = OptionFields.rerank.unwrap().shape;
const HybridFields = RetrievalOptions.shape.hybrid.unwrap().shape;
const ChunkingFields = OptionFields.chunking.unwrap().shape;
const DEFAULT_HYDE_THRESHOLD = 0.35;
const DEFAULT_RERANK_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_HYBRID_OPTIONS = {
    enabled: true,
    mode: "parallel",
    rrfK: 60,
    vectorCandidateMultiplier: 8,
    bm25CandidateMultiplier: 8,
    vectorWeight: 1,
    bm25Weight: 1,
};
const DEFAULT_CHUNKING_OPTIONS = {
    overlap: 0,
    expansion: false,
    minSemanticNonWhitespaceChars: 8,
};
const KIB = Number("1024");
const MIB = KIB * KIB;
const DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS = 2000;
const DEFAULT_MAX_FILE_BYTES = Number("2") * MIB;
const DEFAULT_MAX_CONTEXT_CHARS = 12_000;
const DEFAULT_TOP_K = 5;
const DEFAULT_EXCLUDE_GLOBS = [
    "**/*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,gz,tgz,tar,7z,mp4,mov,mp3,woff,woff2,ttf,eot}",
    "**/bun.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/yarn.lock",
    "**/*.min.js",
    "**/*.map",
];
const DEFAULT_RESULT_OPTIONS = {
    maxChunkNonWhitespaceChars: DEFAULT_MAX_CHUNK_NON_WHITESPACE_CHARS,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxContextChars: DEFAULT_MAX_CONTEXT_CHARS,
    topK: DEFAULT_TOP_K,
    includeGlobs: ["**/*"],
    excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
};
export function parseOptions(input, env = process.env) {
    const inputRecord = parseInputRecord(input);
    const parsed = parseOptionFields(inputRecord.success ? inputRecord.data : {});
    const diagnostics = diagnosticsForOptions(inputRecord, parsed);
    const raw = rawOptions(inputRecord.success ? inputRecord.data : {}, parsed);
    return assembleOptions(raw, diagnostics, env);
}
function parseInputRecord(input) {
    return OptionsRecord.safeParse(input ?? {});
}
function parseOptionFields(data) {
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
    };
}
function diagnosticsForOptions(inputRecord, parsed) {
    const diagnostics = inputRecord.success
        ? []
        : inputRecord.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    for (const [key, result] of Object.entries(parsed)) {
        if (!result.success) {
            diagnostics.push(...result.error.issues.map((issue) => diagnosticMessage(key, issue)));
        }
    }
    return diagnostics;
}
function diagnosticMessage(key, issue) {
    return `${[key, ...issue.path].filter(Boolean).join(".")}: ${issue.message}`;
}
function rawOptions(data, parsed) {
    return {
        embedding: parsedValue(parsed.embedding) ?? parseApiConfig(data.embedding),
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
    };
}
function parsedValue(result) {
    return result.success ? result.data : undefined;
}
function assembleOptions(raw, diagnostics, env) {
    const embedding = embeddingOptions(raw.embedding, apiKeyOption(raw.embedding, env));
    const hyde = hydeOptions(raw.hyde, hasEmbedding(embedding), env);
    addEmbeddingDiagnostics(raw.embedding, diagnostics);
    return {
        embedding,
        hyde,
        rerank: rerankOptions(raw.rerank, apiKeyOption(raw.rerank, env)),
        retrieval: { hybrid: hybridOptions(raw.retrieval?.hybrid) },
        chunking: chunkingOptions(raw.chunking),
        ...resultOptions(raw),
        cacheDir: cacheDirOption(raw.cacheDir, env),
        diagnostics,
    };
}
function apiKeyOption(raw, env) {
    return resolveSecret(raw?.apiKey, raw?.apiKeyEnv, env);
}
function hasEmbedding(embedding) {
    return Boolean(embedding);
}
function resultOptions(raw) {
    return { ...DEFAULT_RESULT_OPTIONS, ...definedProperties(selectResultOptions(raw)) };
}
function selectResultOptions(raw) {
    return {
        maxChunkNonWhitespaceChars: raw.maxChunkNonWhitespaceChars,
        maxFileBytes: raw.maxFileBytes,
        maxContextChars: raw.maxContextChars,
        topK: raw.topK,
        includeGlobs: raw.includeGlobs,
        excludeGlobs: raw.excludeGlobs,
    };
}
function addEmbeddingDiagnostics(raw, diagnostics) {
    if (!raw?.baseURL) {
        diagnostics.push("embedding.baseURL is required");
    }
    if (!raw?.model) {
        diagnostics.push("embedding.model is required");
    }
}
function withDefault(value, defaultValue) {
    return value ?? defaultValue;
}
function cacheDirOption(cacheDir, env) {
    return cacheDir ?? env.OPENCODE_CAST_CACHE_DIR ?? path.join(cacheBaseDir(env), "opencode", "cast");
}
function cacheBaseDir(env) {
    return env.XDG_CACHE_HOME ?? path.join(env.HOME ?? process.cwd(), ".cache");
}
function embeddingOptions(raw, apiKey) {
    return raw?.baseURL && raw.model
        ? { baseURL: raw.baseURL, apiKey, model: raw.model, dimensions: raw.dimensions }
        : undefined;
}
function hydeOptions(raw, hasEmbeddingConfig, env) {
    const api = openAiCompatibleConfig(raw);
    return {
        mode: api ? "openai-compatible" : "opencode",
        baseURL: api?.baseURL,
        apiKey: apiKeyForOpenAiHyde(api, raw, env),
        model: api?.model,
        threshold: withDefault(raw?.threshold, DEFAULT_HYDE_THRESHOLD),
        enabled: withDefault(raw?.enabled, hasEmbeddingConfig),
    };
}
function apiKeyForOpenAiHyde(api, raw, env) {
    return api ? resolveSecret(raw?.apiKey, raw?.apiKeyEnv, env) : undefined;
}
function openAiCompatibleConfig(raw) {
    return raw?.baseURL && raw.model ? { baseURL: raw.baseURL, model: raw.model } : undefined;
}
function rerankOptions(raw, apiKey) {
    return raw?.baseURL && raw.model
        ? {
            baseURL: raw.baseURL,
            apiKey,
            model: raw.model,
            candidateMultiplier: raw.candidateMultiplier ?? DEFAULT_RERANK_CANDIDATE_MULTIPLIER,
        }
        : undefined;
}
function hybridOptions(raw) {
    return { ...DEFAULT_HYBRID_OPTIONS, ...definedProperties(raw) };
}
function chunkingOptions(raw) {
    return { ...DEFAULT_CHUNKING_OPTIONS, ...definedProperties(raw) };
}
function definedProperties(input) {
    return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}
function resolveSecret(value, envName, env) {
    return value ?? (envName ? env[envName] : undefined);
}
function parseApiConfig(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    return {
        baseURL: safeField(ApiFields.baseURL, inputRecord.data.baseURL),
        apiKey: safeField(ApiFields.apiKey, inputRecord.data.apiKey),
        apiKeyEnv: safeField(ApiFields.apiKeyEnv, inputRecord.data.apiKeyEnv),
        model: safeField(ApiFields.model, inputRecord.data.model),
        dimensions: safeField(ApiFields.dimensions, inputRecord.data.dimensions),
    };
}
function parseHydeConfig(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    const api = parseApiConfig(input);
    return {
        ...api,
        enabled: safeField(HydeFields.enabled, inputRecord.data.enabled),
        threshold: safeField(HydeFields.threshold, inputRecord.data.threshold),
    };
}
function parseRerankConfig(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    const api = parseApiConfig(input);
    return {
        baseURL: api?.baseURL,
        apiKey: api?.apiKey,
        apiKeyEnv: api?.apiKeyEnv,
        model: api?.model,
        candidateMultiplier: safeField(RerankFields.candidateMultiplier, inputRecord.data.candidateMultiplier),
    };
}
function parseRetrievalOptions(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    return {
        hybrid: parseHybridOptions(inputRecord.data.hybrid),
    };
}
function parseChunkingOptions(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    return {
        overlap: safeField(ChunkingFields.overlap, inputRecord.data.overlap),
        expansion: safeField(ChunkingFields.expansion, inputRecord.data.expansion),
        minSemanticNonWhitespaceChars: safeField(ChunkingFields.minSemanticNonWhitespaceChars, inputRecord.data.minSemanticNonWhitespaceChars),
    };
}
function parseHybridOptions(input) {
    const inputRecord = OptionsRecord.safeParse(input ?? {});
    if (!inputRecord.success) {
        return;
    }
    return {
        enabled: safeField(HybridFields.enabled, inputRecord.data.enabled),
        mode: safeField(HybridFields.mode, inputRecord.data.mode),
        rrfK: safeField(HybridFields.rrfK, inputRecord.data.rrfK),
        vectorCandidateMultiplier: safeField(HybridFields.vectorCandidateMultiplier, inputRecord.data.vectorCandidateMultiplier),
        bm25CandidateMultiplier: safeField(HybridFields.bm25CandidateMultiplier, inputRecord.data.bm25CandidateMultiplier),
        vectorWeight: safeField(HybridFields.vectorWeight, inputRecord.data.vectorWeight),
        bm25Weight: safeField(HybridFields.bm25Weight, inputRecord.data.bm25Weight),
    };
}
function safeField(schema, input) {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
}
