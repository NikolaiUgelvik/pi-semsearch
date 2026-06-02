import { describe, expect, test } from "vitest"
import { parseOptions } from "./options.js"

describe("parseOptions", () => {
  test("applies defaults and resolves api keys from env", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKeyEnv: "CAST_TEST_KEY",
          model: "text-embedding-3-small",
        },
        hyde: {
          model: "gpt-4o-mini",
          threshold: 0.42,
        },
      },
      { CAST_TEST_KEY: "secret" },
    )

    expect(options.embedding).toEqual({
      baseURL: "https://example.test/v1",
      apiKey: "secret",
      model: "text-embedding-3-small",
      dimensions: undefined,
      batchSize: 16,
      concurrency: 1,
      timeoutMs: 30_000,
    })
    expect(options.hyde).toEqual({
      mode: "pi-active",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.42,
      enabled: true,
      timeoutMs: 30_000,
    })
    expect(options.maxChunkNonWhitespaceChars).toBe(2000)
    expect(options.maxContextChars).toBe(12_000)
    expect(options.maxFileBytes).toBe(2 * 1024 * 1024)
    expect(options.topK).toBe(5)
    expect(options.includeGlobs).toEqual(["**/*"])
    for (const excludeGlob of [
      "**/*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,gz,tgz,tar,7z,mp4,mov,mp3,woff,woff2,ttf,eot}",
      "**/bun.lock",
      "**/__pycache__/**",
      "**/*.{pyc,pyo,pyd}",
      "**/.venv/**",
      "**/coverage/**",
      "**/.next/**",
      "**/target/**",
      "**/.gradle/**",
      "**/*.{class,jar,war,ear}",
      "**/.bundle/**",
      "**/vendor/**",
    ]) {
      expect(options.excludeGlobs).toContain(excludeGlob)
    }
    expect(options.retrieval.hybrid).toEqual({
      enabled: true,
      rrfK: 60,
      vectorCandidateMultiplier: 8,
      bm25CandidateMultiplier: 8,
      vectorWeight: 1,
      bm25Weight: 1,
    })
    expect(options.retrieval.maxVectorCandidates).toBe(512)
    expect(options.retrieval.maxRerankCandidates).toBe(64)
  })

  test("parses configured embedding batch size", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
          batchSize: 4,
        },
      },
      {},
    )

    expect(options.embedding?.batchSize).toBe(4)
  })

  test("parses configured provider request timeouts", () => {
    const options = parseOptions(
      {
        embedding: { baseURL: "https://example.test/v1", model: "embed", timeoutMs: 5000 },
        hyde: { baseURL: "https://hyde.example.test/v1", model: "chat", timeoutMs: 6000 },
        rerank: { baseURL: "https://rerank.example.test/v1", model: "rerank", timeoutMs: 7000 },
      },
      {},
    )

    expect(options.embedding?.timeoutMs).toBe(5000)
    expect(options.hyde.timeoutMs).toBe(6000)
    expect(options.rerank?.timeoutMs).toBe(7000)
  })

  test("reports invalid provider request timeouts and falls back to defaults", () => {
    const options = parseOptions(
      {
        embedding: { baseURL: "https://example.test/v1", model: "embed", timeoutMs: 0 },
        hyde: { baseURL: "https://hyde.example.test/v1", model: "chat", timeoutMs: -1 },
        rerank: { baseURL: "https://rerank.example.test/v1", model: "rerank", timeoutMs: 0 },
      },
      {},
    )

    expect(options.embedding?.timeoutMs).toBe(30_000)
    expect(options.hyde.timeoutMs).toBe(30_000)
    expect(options.rerank?.timeoutMs).toBe(30_000)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("embedding.timeoutMs:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("hyde.timeoutMs:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("rerank.timeoutMs:"))).toBe(true)
  })

  test("caps unsafe embedding batch and concurrency settings", () => {
    const options = parseOptions({
      embedding: { baseURL: "https://example.test/v1", model: "embed", batchSize: 9999, concurrency: 99 },
    })

    expect(options.embedding?.batchSize).toBe(2048)
    expect(options.embedding?.concurrency).toBe(8)
    expect(options.diagnostics).toContain("embedding.batchSize: Number must be less than or equal to 2048")
    expect(options.diagnostics).toContain("embedding.concurrency: Number must be less than or equal to 8")
  })

  test("parses embedding concurrency", () => {
    const options = parseOptions({
      embedding: { baseURL: "https://example.test/v1", model: "embed", concurrency: 3 },
    })

    expect(options.embedding?.concurrency).toBe(3)
  })

  test("rejects invalid embedding concurrency", () => {
    const options = parseOptions({
      embedding: { baseURL: "https://example.test/v1", model: "embed", concurrency: 0 },
    })

    expect(options.diagnostics).toContain("embedding.concurrency: Number must be greater than 0")
  })

  test("parses configured hybrid retrieval options", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        retrieval: {
          hybrid: {
            enabled: false,
            rrfK: 40,
            vectorCandidateMultiplier: 5,
            bm25CandidateMultiplier: 9,
            vectorWeight: 0.75,
            bm25Weight: 1.25,
          },
        },
      },
      {},
    )

    expect(options.retrieval.hybrid).toEqual({
      enabled: false,
      rrfK: 40,
      vectorCandidateMultiplier: 5,
      bm25CandidateMultiplier: 9,
      vectorWeight: 0.75,
      bm25Weight: 1.25,
    })
  })

  test("parses retrieval candidate caps", () => {
    const options = parseOptions({
      retrieval: {
        maxVectorCandidates: 128,
        maxRerankCandidates: 16,
      },
    })

    expect(options.retrieval.maxVectorCandidates).toBe(128)
    expect(options.retrieval.maxRerankCandidates).toBe(16)
  })

  test("parses configured rerank options and resolves api key from env", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "embedding-key",
          model: "text-embedding-3-small",
        },
        rerank: {
          baseURL: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
          model: "cohere/rerank-4-fast",
          candidateMultiplier: 6,
        },
      },
      { OPENROUTER_API_KEY: "rerank-key" },
    )

    expect(options.rerank).toEqual({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "rerank-key",
      model: "cohere/rerank-4-fast",
      candidateMultiplier: 6,
      timeoutMs: 30_000,
    })
  })

  test("defaults rerank candidate multiplier when rerank is configured", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "embedding-key",
          model: "text-embedding-3-small",
        },
        rerank: {
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "rerank-key",
          model: "cohere/rerank-4-fast",
        },
      },
      {},
    )

    expect(options.rerank).toEqual({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "rerank-key",
      model: "cohere/rerank-4-fast",
      candidateMultiplier: 4,
      timeoutMs: 30_000,
    })
  })

  test("reports invalid rerank fields without disabling valid embedding config", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "embedding-key",
          model: "text-embedding-3-small",
        },
        rerank: {
          baseURL: "not a url",
          model: 42,
          candidateMultiplier: 0,
        },
      },
      {},
    )

    expect(options.embedding).toEqual({
      baseURL: "https://example.test/v1",
      apiKey: "embedding-key",
      model: "text-embedding-3-small",
      dimensions: undefined,
      batchSize: 16,
      concurrency: 1,
      timeoutMs: 30_000,
    })
    expect(options.rerank).toBeUndefined()
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("rerank.baseURL:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("rerank.model:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("rerank.candidateMultiplier:"))).toBe(true)
  })

  test("reports invalid hybrid retrieval options", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        retrieval: {
          hybrid: {
            rrfK: 0,
          },
        },
      },
      {},
    )

    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("retrieval.hybrid.rrfK:"))).toBe(true)
  })

  test("applies chunking defaults", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
      },
      {},
    )

    expect(options.chunking).toEqual({
      overlap: 0,
      expansion: false,
      minSemanticNonWhitespaceChars: 8,
    })
  })

  test("parses configured chunking options", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        chunking: {
          overlap: 1,
          expansion: true,
          minSemanticNonWhitespaceChars: 12,
        },
      },
      {},
    )

    expect(options.chunking).toEqual({
      overlap: 1,
      expansion: true,
      minSemanticNonWhitespaceChars: 12,
    })
  })

  test("reports invalid chunking options and falls back to defaults", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        chunking: {
          overlap: -1,
          expansion: "yes",
          minSemanticNonWhitespaceChars: 0,
        },
      },
      {},
    )

    expect(options.chunking).toEqual({
      overlap: 0,
      expansion: false,
      minSemanticNonWhitespaceChars: 8,
    })
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("chunking.overlap:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("chunking.expansion:"))).toBe(true)
    expect(
      options.diagnostics.some((diagnostic) => diagnostic.startsWith("chunking.minSemanticNonWhitespaceChars:")),
    ).toBe(true)
  })

  test("preserves valid chunking fields when a sibling field is invalid", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        chunking: {
          overlap: -1,
          expansion: true,
          minSemanticNonWhitespaceChars: 12,
        },
      },
      {},
    )

    expect(options.chunking).toEqual({
      overlap: 0,
      expansion: true,
      minSemanticNonWhitespaceChars: 12,
    })
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("chunking.overlap:"))).toBe(true)
  })

  test("returns missing embedding config instead of throwing", () => {
    const options = parseOptions({}, {})

    expect(options.embedding).toBeUndefined()
    expect(options.hyde.enabled).toBe(false)
    expect(options.diagnostics).toContain("embedding.model is required")
    expect(options.diagnostics).toContain("embedding.baseURL is required")
  })

  test("enables Pi active model HyDE by default when embeddings are configured", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
      },
      {},
    )

    expect(options.hyde).toEqual({
      mode: "pi-active",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.35,
      enabled: true,
      timeoutMs: 30_000,
    })
  })

  test("keeps hyde disabled when explicitly disabled", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        hyde: {
          enabled: false,
        },
      },
      {},
    )

    expect(options.hyde).toEqual({
      mode: "disabled",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.35,
      enabled: false,
      timeoutMs: 30_000,
    })
  })

  test("enables Pi active model HyDE for threshold-only config", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        hyde: {
          threshold: 0.6,
        },
      },
      {},
    )

    expect(options.hyde).toEqual({
      mode: "pi-active",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.6,
      enabled: true,
      timeoutMs: 30_000,
    })
  })

  test("uses Pi active model HyDE when explicitly enabled without an OpenAI-compatible provider", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        hyde: {
          model: "gpt-4o-mini",
          threshold: 0.2,
          enabled: true,
        },
      },
      {},
    )

    expect(options.hyde).toEqual({
      mode: "pi-active",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.2,
      enabled: true,
      timeoutMs: 30_000,
    })
  })

  test("uses openai-compatible hyde mode when base url and model are configured", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "embedding-key",
          model: "text-embedding-3-small",
        },
        hyde: {
          baseURL: "https://hyde.example.test/v1",
          apiKeyEnv: "HYDE_KEY",
          model: "gpt-4o-mini",
          threshold: 0.2,
        },
      },
      { HYDE_KEY: "hyde-secret" },
    )

    expect(options.hyde).toEqual({
      mode: "openai-compatible",
      baseURL: "https://hyde.example.test/v1",
      apiKey: "hyde-secret",
      model: "gpt-4o-mini",
      threshold: 0.2,
      enabled: true,
      timeoutMs: 30_000,
    })
  })

  test("uses PI_SEMSEARCH_CACHE_DIR before xdg fallback", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
      },
      { PI_SEMSEARCH_CACHE_DIR: "/tmp/semsearch-cache" },
    )

    expect(options.cacheDir).toBe("/tmp/semsearch-cache")
  })

  test("preserves valid embedding when optional fields are invalid", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        topK: 0,
      },
      {},
    )

    expect(options.embedding).toEqual({
      baseURL: "https://example.test/v1",
      apiKey: "literal",
      model: "text-embedding-3-small",
      dimensions: undefined,
      batchSize: 16,
      concurrency: 1,
      timeoutMs: 30_000,
    })
    expect(options.topK).toBe(5)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("topK:"))).toBe(true)
    expect(options.diagnostics).not.toContain("embedding.baseURL is required")
    expect(options.diagnostics).not.toContain("embedding.model is required")
  })

  test("parses configured file scanning limits", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        maxFileBytes: 4096,
        excludeGlobs: ["**/*.generated.ts"],
      },
      {},
    )

    expect(options.maxFileBytes).toBe(4096)
    expect(options.excludeGlobs).toEqual(["**/*.generated.ts"])
  })

  test("reports invalid maxFileBytes and falls back to default", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        maxFileBytes: 0,
      },
      {},
    )

    expect(options.maxFileBytes).toBe(2 * 1024 * 1024)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("maxFileBytes:"))).toBe(true)
  })

  test("preserves valid embedding fields when dimensions is invalid", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
          dimensions: 0,
        },
      },
      {},
    )

    expect(options.embedding).toEqual({
      baseURL: "https://example.test/v1",
      apiKey: "literal",
      model: "text-embedding-3-small",
      dimensions: undefined,
      batchSize: 16,
      concurrency: 1,
      timeoutMs: 30_000,
    })
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("embedding.dimensions:"))).toBe(true)
    expect(options.diagnostics).not.toContain("embedding.baseURL is required")
    expect(options.diagnostics).not.toContain("embedding.model is required")
  })

  test("reports invalid hyde fields while falling back to Pi active model HyDE", () => {
    const options = parseOptions(
      {
        embedding: {
          baseURL: "https://example.test/v1",
          apiKey: "literal",
          model: "text-embedding-3-small",
        },
        hyde: {
          baseURL: "not a url",
          model: 42,
          threshold: 2,
        },
      },
      {},
    )

    expect(options.hyde).toEqual({
      mode: "pi-active",
      baseURL: undefined,
      apiKey: undefined,
      model: undefined,
      threshold: 0.35,
      enabled: true,
      timeoutMs: 30_000,
    })
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("hyde.baseURL:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("hyde.model:"))).toBe(true)
    expect(options.diagnostics.some((diagnostic) => diagnostic.startsWith("hyde.threshold:"))).toBe(true)
    expect(options.diagnostics).not.toContain("embedding.baseURL is required")
    expect(options.diagnostics).not.toContain("embedding.model is required")
  })
})
