import { HYDE_SYSTEM_PROMPT } from "./hyde.js"

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
export type SleepLike = (ms: number, signal?: AbortSignal | null) => Promise<void>
export type RandomLike = () => number
type TimeoutHandle = ReturnType<typeof setTimeout>
interface SignalInput {
  signal?: AbortSignal
  timeoutMs?: number
}

const TRAILING_SLASHES_PATTERN = /\/+$/
const EMBEDDING_RETRIES = 2
const NON_EMBEDDING_RETRIES = 1
const EMBEDDING_RETRY_DELAY_MS = 10
const MS_PER_SECOND = 1000
const HTTP_REQUEST_TIMEOUT = 408
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_SERVER_ERROR_MIN = 500

export function createOpenAIClient(options: { fetch?: FetchLike; sleep?: SleepLike; random?: RandomLike } = {}) {
  const request = options.fetch ?? fetch
  const sleep = options.sleep ?? delay
  const random = options.random ?? Math.random

  return {
    embed: (
      input: { baseURL: string; apiKey?: string; model: string; dimensions?: number; input: string } & SignalInput,
    ) => embed({ request, sleep, random }, input),

    embedBatch: (
      input: { baseURL: string; apiKey?: string; model: string; dimensions?: number; input: string[] } & SignalInput,
    ) => embedBatch({ request, sleep, random }, input),

    generateHyde: (input: { baseURL: string; apiKey?: string; model: string; query: string } & SignalInput) =>
      generateHyde({ request, sleep, random }, input),

    rerank: (
      input: { baseURL: string; apiKey?: string; model: string; query: string; documents: string[] } & SignalInput,
    ) => rerank({ request, sleep, random }, input),
  }
}

interface RequestContext {
  request: FetchLike
  sleep: SleepLike
  random: RandomLike
}

async function embed(
  context: RequestContext,
  input: { baseURL: string; apiKey?: string; model: string; dimensions?: number; input: string } & SignalInput,
) {
  const body = await requestEmbeddings(context, input)
  return embeddingFromBody(body)
}

async function embedBatch(
  context: RequestContext,
  input: { baseURL: string; apiKey?: string; model: string; dimensions?: number; input: string[] } & SignalInput,
) {
  const body = await requestEmbeddings(context, input)
  return embeddingsFromBody(body, input.input.length)
}

async function requestEmbeddings(
  context: RequestContext,
  input: {
    baseURL: string
    apiKey?: string
    model: string
    dimensions?: number
    input: string | string[]
  } & SignalInput,
) {
  const body = await requestJsonWithRetries({
    ...context,
    url: `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/embeddings`,
    init: {
      method: "POST",
      headers: buildHeaders(input.apiKey),
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        input: input.input,
        ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
      }),
    },
    label: "Embedding",
    retries: EMBEDDING_RETRIES,
    timeoutMs: input.timeoutMs,
  })
  return body
}

async function generateHyde(
  context: RequestContext,
  input: { baseURL: string; apiKey?: string; model: string; query: string } & SignalInput,
) {
  const body = await requestJsonWithRetries({
    ...context,
    url: `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/chat/completions`,
    init: {
      method: "POST",
      headers: buildHeaders(input.apiKey),
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        messages: [
          {
            role: "system",
            content: HYDE_SYSTEM_PROMPT,
          },
          { role: "user", content: input.query },
        ],
        temperature: 0,
      }),
    },
    label: "HyDE",
    retries: NON_EMBEDDING_RETRIES,
    timeoutMs: input.timeoutMs,
  })
  return hydeContentFromBody(body)
}

async function rerank(
  context: RequestContext,
  input: { baseURL: string; apiKey?: string; model: string; query: string; documents: string[] } & SignalInput,
) {
  const body = await requestJsonWithRetries({
    ...context,
    url: `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/rerank`,
    init: {
      method: "POST",
      headers: buildHeaders(input.apiKey),
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
        query: input.query,
        documents: input.documents,
      }),
    },
    label: "Rerank",
    retries: NON_EMBEDDING_RETRIES,
    timeoutMs: input.timeoutMs,
  })
  return rerankResultsFromBody(body, input.documents.length)
}

function requestJsonWithRetries(input: {
  request: FetchLike
  url: string
  init: RequestInit
  label: string
  retries: number
  timeoutMs?: number
  sleep: SleepLike
  random: RandomLike
}) {
  const attemptRequest = async (attempt: number): Promise<unknown> => {
    input.init.signal?.throwIfAborted()
    const timeout = withTimeoutSignal(input.init, input.timeoutMs)
    const response = await input.request(input.url, timeout.init).finally(timeout.cancel)
    if (response.ok) {
      return response.json().catch(() => undefined)
    }
    if (attempt >= input.retries || !isTransientStatus(response.status)) {
      throw new Error(`${input.label} request failed: ${response.status}`)
    }
    await input.sleep(retryDelayMs(response, attempt, input.random), input.init.signal)
    return attemptRequest(attempt + 1)
  }
  return attemptRequest(0)
}

function isTransientStatus(status: number) {
  return status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN
}

function retryDelayMs(response: Response, attempt: number, random: RandomLike) {
  return retryAfterDelayMs(response.headers.get("retry-after")) ?? exponentialJitterDelayMs(attempt, random)
}

function retryAfterDelayMs(value: string | null) {
  if (!value) {
    return
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * MS_PER_SECOND
  }
  const dateMs = Date.parse(value)
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now())
}

function exponentialJitterDelayMs(attempt: number, random: RandomLike) {
  return EMBEDDING_RETRY_DELAY_MS * 2 ** attempt * (1 + Math.min(1, Math.max(0, random())))
}

function withTimeoutSignal(init: RequestInit, timeoutMs: number | undefined) {
  if (!timeoutMs) {
    return { init, cancel: noop }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
  const abort = () => controller.abort(init.signal?.reason)
  init.signal?.addEventListener("abort", abort, { once: true })
  return {
    init: { ...init, signal: controller.signal },
    cancel: () => {
      clearTimeout(timeout)
      init.signal?.removeEventListener("abort", abort)
    },
  }
}

function noop() {
  return
}

function delay(ms: number, signal?: AbortSignal | null) {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason)
    }
    const timeout: TimeoutHandle = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function embeddingFromBody(body: unknown) {
  const embedding = arrayProperty(body, "data")?.[0]?.embedding
  if (isNumberArray(embedding) && embedding.length > 0) {
    return embedding
  }
  throw new Error("Embedding response did not include data[0].embedding")
}

function embeddingsFromBody(body: unknown, expectedCount: number) {
  const data = arrayProperty(body, "data")
  if (data?.length !== expectedCount) {
    throw new Error("Embedding response did not include one embedding per input")
  }
  return data.map((item) => {
    const embedding = isRecord(item) ? item.embedding : undefined
    if (isNumberArray(embedding) && embedding.length > 0) {
      return embedding
    }
    throw new Error("Embedding response did not include one embedding per input")
  })
}

function hydeContentFromBody(body: unknown) {
  const content = arrayProperty(body, "choices")?.[0]?.message?.content
  if (typeof content === "string" && content.trim() !== "") {
    return content.trim()
  }
  throw new Error("HyDE response did not include choices[0].message.content")
}

function rerankResultsFromBody(body: unknown, documentCount: number) {
  const results = arrayProperty(body, "results")
  if (!results) {
    throw new Error("Rerank response did not include results")
  }
  return results.map((result) => rerankResultFromBody(result, documentCount))
}

function rerankResultFromBody(result: unknown, documentCount: number) {
  const record = isRecord(result) ? result : {}
  const index = record.index
  const score = record.relevance_score
  if (!isValidRerankIndex(index, documentCount)) {
    throw new Error("Rerank response included invalid result index")
  }
  if (typeof score !== "number" || Number.isNaN(score)) {
    throw new Error("Rerank response included invalid relevance score")
  }
  return { index, score }
}

function isValidRerankIndex(value: unknown, documentCount: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < documentCount
}

function arrayProperty(value: unknown, key: string) {
  const property = isRecord(value) ? value[key] : undefined
  return Array.isArray(property) ? property : undefined
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey
    ? {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      }
    : { "content-type": "application/json" }
}
