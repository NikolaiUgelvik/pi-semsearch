import { describe, expect, test } from "vitest"
import { HYDE_SYSTEM_PROMPT } from "./hyde.js"
import { createOpenAIClient } from "./openai.js"

type AddAbortListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => void
type RemoveAbortListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
) => void

describe("createOpenAIClient", () => {
  test("embeds text with OpenAI-compatible request shape", async () => {
    const calls: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        calls.push({ url, init })
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
      },
    })

    const embedding = await client.embed({
      baseURL: "https://example.test/v1/",
      apiKey: "key",
      model: "embed",
      input: "hello",
    })

    expect(embedding).toEqual([0.1, 0.2, 0.3])
    expect(calls).toHaveLength(1)
    expect((calls[0] as { url: string }).url).toBe("https://example.test/v1/embeddings")
    expect((calls[0] as { init: RequestInit }).init.method).toBe("POST")
    expect((calls[0] as { init: RequestInit }).init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer key",
    })
    expect(JSON.parse(String((calls[0] as { init: RequestInit }).init.body))).toEqual({
      model: "embed",
      input: "hello",
    })
  })

  test("passes optional embedding dimensions", async () => {
    const bodies: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ data: [{ embedding: [1] }] })
      },
    })

    await client.embed({
      baseURL: "https://example.test/v1",
      apiKey: "key",
      model: "embed",
      dimensions: 1,
      input: "hello",
    })

    expect(bodies).toEqual([{ model: "embed", input: "hello", dimensions: 1 }])
  })

  test("embeds batches with OpenAI-compatible request shape", async () => {
    const bodies: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ data: [{ embedding: [1] }, { embedding: [2] }] })
      },
    })

    const embeddings = await client.embedBatch({
      baseURL: "https://example.test/v1",
      apiKey: "key",
      model: "embed",
      input: ["first", "second"],
    })

    expect(embeddings).toEqual([[1], [2]])
    expect(bodies).toEqual([{ model: "embed", input: ["first", "second"] }])
  })

  test("passes abort signals to OpenAI-compatible requests", async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | null | undefined> = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        signals.push(init.signal)
        if (url.endsWith("/chat/completions")) {
          return Response.json({ choices: [{ message: { content: "hyde text" } }] })
        }
        if (url.endsWith("/rerank")) {
          return Response.json({ results: [{ index: 0, relevance_score: 1 }] })
        }
        return Response.json({ data: [{ embedding: [1] }] })
      },
    })

    await client.embed({
      baseURL: "https://example.test/v1",
      model: "embed",
      input: "hello",
      signal: controller.signal,
    })
    await client.embedBatch({
      baseURL: "https://example.test/v1",
      model: "embed",
      input: ["hello"],
      signal: controller.signal,
    })
    await client.generateHyde({
      baseURL: "https://example.test/v1",
      model: "chat",
      query: "hello",
      signal: controller.signal,
    })
    await client.rerank({
      baseURL: "https://example.test/v1",
      model: "rerank",
      query: "hello",
      documents: ["document"],
      signal: controller.signal,
    })

    expect(signals).toEqual([controller.signal, controller.signal, controller.signal, controller.signal])
  })

  test("timeoutMs creates aborting request signals for embedding, HyDE, and rerank requests", async () => {
    const seen: Array<{ url: string; aborted: boolean }> = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        await wait(20)
        seen.push({ url, aborted: init.signal?.aborted ?? false })
        return successfulResponse(url)
      },
    })

    await client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "hello", timeoutMs: 1 })
    await client.generateHyde({ baseURL: "https://example.test/v1", model: "chat", query: "hello", timeoutMs: 1 })
    await client.rerank({
      baseURL: "https://example.test/v1",
      model: "rerank",
      query: "hello",
      documents: ["document"],
      timeoutMs: 1,
    })

    expect(seen).toEqual([
      { url: "https://example.test/v1/embeddings", aborted: true },
      { url: "https://example.test/v1/chat/completions", aborted: true },
      { url: "https://example.test/v1/rerank", aborted: true },
    ])
  })

  test("caller abort signals propagate through timeout-wrapped request signals", async () => {
    const seen: Array<{ url: string; aborted: boolean; originalSignal: boolean }> = []
    const controllers: AbortController[] = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        const controller = controllers.shift()
        controller?.abort("caller abort")
        await Promise.resolve()
        seen.push({
          url,
          aborted: init.signal?.aborted ?? false,
          originalSignal: init.signal === controller?.signal,
        })
        return successfulResponse(url)
      },
    })

    const embeddingController = new AbortController()
    controllers.push(embeddingController)
    await client.embed({
      baseURL: "https://example.test/v1",
      model: "embed",
      input: "hello",
      timeoutMs: 30_000,
      signal: embeddingController.signal,
    })

    const hydeController = new AbortController()
    controllers.push(hydeController)
    await client.generateHyde({
      baseURL: "https://example.test/v1",
      model: "chat",
      query: "hello",
      timeoutMs: 30_000,
      signal: hydeController.signal,
    })

    const rerankController = new AbortController()
    controllers.push(rerankController)
    await client.rerank({
      baseURL: "https://example.test/v1",
      model: "rerank",
      query: "hello",
      documents: ["document"],
      timeoutMs: 30_000,
      signal: rerankController.signal,
    })

    expect(seen).toEqual([
      { url: "https://example.test/v1/embeddings", aborted: true, originalSignal: false },
      { url: "https://example.test/v1/chat/completions", aborted: true, originalSignal: false },
      { url: "https://example.test/v1/rerank", aborted: true, originalSignal: false },
    ])
  })

  test("retries transient embedding failures", async () => {
    let calls = 0
    const client = createOpenAIClient({
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          return new Response("rate limited", { status: 429 })
        }
        return Response.json({ data: [{ embedding: [1, 0, 0] }] })
      },
    })

    await expect(
      client.embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "text",
      }),
    ).resolves.toEqual([1, 0, 0])
    expect(calls).toBe(2)
  })

  test("honors Retry-After for transient embedding failures", async () => {
    const delays: number[] = []
    let calls = 0
    const client = createOpenAIClient({
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })
        }
        return Response.json({ data: [{ embedding: [1] }] })
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0.5,
    })

    await expect(client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "text" })).resolves.toEqual([
      1,
    ])

    expect(delays).toEqual([2000])
  })

  test("uses exponential backoff with jitter for transient embedding failures", async () => {
    const delays: number[] = []
    let calls = 0
    const client = createOpenAIClient({
      fetch: async () => {
        calls += 1
        if (calls < 3) {
          return new Response("temporarily unavailable", { status: 503 })
        }
        return Response.json({ data: [{ embedding: [1] }] })
      },
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0.5,
    })

    await expect(client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "text" })).resolves.toEqual([
      1,
    ])

    expect(delays).toEqual([15, 30])
  })

  test("cleans up retry delay abort listeners after normal delay resolution", async () => {
    const controller = new AbortController()
    const listeners = new Set<EventListenerOrEventListenerObject>()
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal) as AddAbortListener
    const originalRemoveEventListener = controller.signal.removeEventListener.bind(
      controller.signal,
    ) as RemoveAbortListener
    controller.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "abort" && listener) {
        listeners.add(listener)
      }
      originalAddEventListener(type, listener, options)
    }) as AbortSignal["addEventListener"]
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "abort" && listener) {
        listeners.delete(listener)
      }
      originalRemoveEventListener(type, listener, options)
    }) as AbortSignal["removeEventListener"]
    let calls = 0
    const client = createOpenAIClient({
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          return new Response("temporarily unavailable", { status: 503 })
        }
        return Response.json({ data: [{ embedding: [1] }] })
      },
    })

    await expect(
      client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "text", signal: controller.signal }),
    ).resolves.toEqual([1])

    expect(listeners.size).toBe(0)
  })

  test("does not retry permanent embedding failures", async () => {
    let calls = 0
    const client = createOpenAIClient({
      fetch: async () => {
        calls += 1
        return new Response("bad request", { status: 400 })
      },
    })

    await expect(
      client.embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "text",
      }),
    ).rejects.toThrow("Embedding request failed: 400")
    expect(calls).toBe(1)
  })

  test("generates HyDE text with chat completions", async () => {
    const calls: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        calls.push({ url, init })
        return Response.json({ choices: [{ message: { content: " look for class Session and method prompt " } }] })
      },
    })

    const text = await client.generateHyde({
      baseURL: "https://example.test/v1/",
      apiKey: "key",
      model: "chat",
      query: "where is prompt handled?",
    })

    expect(text).toBe("look for class Session and method prompt")
    expect((calls[0] as { url: string }).url).toBe("https://example.test/v1/chat/completions")
    expect(JSON.parse(String((calls[0] as { init: RequestInit }).init.body))).toEqual({
      model: "chat",
      messages: [
        {
          role: "system",
          content: HYDE_SYSTEM_PROMPT,
        },
        { role: "user", content: "where is prompt handled?" },
      ],
      temperature: 0,
    })
  })

  test("retries transient HyDE and rerank failures once", async () => {
    const calls: string[] = []
    const client = createOpenAIClient({
      fetch: async (url) => {
        calls.push(url)
        if (calls.filter((call) => call === url).length === 1) {
          return new Response("temporarily unavailable", { status: 503 })
        }
        if (url.endsWith("/rerank")) {
          return Response.json({ results: [{ index: 0, relevance_score: 1 }] })
        }
        return Response.json({ choices: [{ message: { content: "hyde text" } }] })
      },
      sleep: async () => {
        return
      },
      random: () => 0.5,
    })

    await expect(
      client.generateHyde({ baseURL: "https://example.test/v1", model: "chat", query: "hello" }),
    ).resolves.toBe("hyde text")
    await expect(
      client.rerank({ baseURL: "https://example.test/v1", model: "rerank", query: "hello", documents: ["document"] }),
    ).resolves.toEqual([{ index: 0, score: 1 }])

    expect(calls).toEqual([
      "https://example.test/v1/chat/completions",
      "https://example.test/v1/chat/completions",
      "https://example.test/v1/rerank",
      "https://example.test/v1/rerank",
    ])
  })

  test("reranks documents with OpenRouter-compatible request shape", async () => {
    const calls: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (url, init) => {
        calls.push({ url, init })
        return Response.json({
          results: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.12 },
          ],
        })
      },
    })

    const results = await client.rerank({
      baseURL: "https://openrouter.ai/api/v1/",
      apiKey: "key",
      model: "cohere/rerank-4-fast",
      query: "find parser errors",
      documents: ["a", "b"],
    })

    expect(results).toEqual([
      { index: 1, score: 0.91 },
      { index: 0, score: 0.12 },
    ])
    expect((calls[0] as { url: string }).url).toBe("https://openrouter.ai/api/v1/rerank")
    expect((calls[0] as { init: RequestInit }).init.method).toBe("POST")
    expect((calls[0] as { init: RequestInit }).init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer key",
    })
    expect(JSON.parse(String((calls[0] as { init: RequestInit }).init.body))).toEqual({
      model: "cohere/rerank-4-fast",
      query: "find parser errors",
      documents: ["a", "b"],
    })
  })

  test("throws clear errors for failed and malformed rerank responses", async () => {
    await expect(
      createOpenAIClient({ fetch: async () => new Response("nope", { status: 503 }) }).rerank({
        baseURL: "https://openrouter.ai/api/v1",
        model: "cohere/rerank-4-fast",
        query: "hello",
        documents: ["a"],
      }),
    ).rejects.toThrow("Rerank request failed: 503")

    await expect(
      createOpenAIClient({
        fetch: async () => Response.json({ results: [{ index: 2, relevance_score: 0.5 }] }),
      }).rerank({
        baseURL: "https://openrouter.ai/api/v1",
        model: "cohere/rerank-4-fast",
        query: "hello",
        documents: ["a"],
      }),
    ).rejects.toThrow("Rerank response included invalid result index")

    await expect(
      createOpenAIClient({
        fetch: async () => Response.json({ results: [{ index: 0, relevance_score: "bad" }] }),
      }).rerank({
        baseURL: "https://openrouter.ai/api/v1",
        model: "cohere/rerank-4-fast",
        query: "hello",
        documents: ["a"],
      }),
    ).rejects.toThrow("Rerank response included invalid relevance score")

    await expect(
      createOpenAIClient({ fetch: async () => new Response("not-json") }).rerank({
        baseURL: "https://openrouter.ai/api/v1",
        model: "cohere/rerank-4-fast",
        query: "hello",
        documents: ["a"],
      }),
    ).rejects.toThrow("Rerank response did not include results")
  })

  test("omits authorization header when api key is missing", async () => {
    const headers: unknown[] = []
    const client = createOpenAIClient({
      fetch: async (_url, init) => {
        headers.push(init?.headers)
        return Response.json({ data: [{ embedding: [1] }] })
      },
    })

    await client.embed({ baseURL: "https://example.test/v1", model: "embed", input: "hello" })

    expect(headers).toEqual([{ "content-type": "application/json" }])
  })

  test("throws clear errors for failed and malformed responses", async () => {
    await expect(
      createOpenAIClient({ fetch: async () => new Response("nope", { status: 500 }) }).embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "hello",
      }),
    ).rejects.toThrow("Embedding request failed: 500")

    await expect(
      createOpenAIClient({ fetch: async () => Response.json({ data: [] }) }).embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "hello",
      }),
    ).rejects.toThrow("Embedding response did not include data[0].embedding")

    await expect(
      createOpenAIClient({ fetch: async () => new Response("nope", { status: 429 }) }).generateHyde({
        baseURL: "https://example.test/v1",
        model: "chat",
        query: "hello",
      }),
    ).rejects.toThrow("HyDE request failed: 429")

    await expect(
      createOpenAIClient({
        fetch: async () => Response.json({ choices: [{ message: { content: "   " } }] }),
      }).generateHyde({
        baseURL: "https://example.test/v1",
        model: "chat",
        query: "hello",
      }),
    ).rejects.toThrow("HyDE response did not include choices[0].message.content")
  })

  test("rejects empty embedding arrays", async () => {
    await expect(
      createOpenAIClient({ fetch: async () => Response.json({ data: [{ embedding: [] }] }) }).embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "hello",
      }),
    ).rejects.toThrow("Embedding response did not include data[0].embedding")
  })

  test("maps invalid embedding JSON to malformed response error", async () => {
    await expect(
      createOpenAIClient({ fetch: async () => new Response("not-json") }).embed({
        baseURL: "https://example.test/v1",
        model: "embed",
        input: "hello",
      }),
    ).rejects.toThrow("Embedding response did not include data[0].embedding")
  })

  test("maps invalid HyDE JSON to malformed response error", async () => {
    await expect(
      createOpenAIClient({ fetch: async () => new Response("not-json") }).generateHyde({
        baseURL: "https://example.test/v1",
        model: "chat",
        query: "hello",
      }),
    ).rejects.toThrow("HyDE response did not include choices[0].message.content")
  })
})

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function successfulResponse(url: string) {
  if (url.endsWith("/chat/completions")) {
    return Response.json({ choices: [{ message: { content: "hyde text" } }] })
  }
  if (url.endsWith("/rerank")) {
    return Response.json({ results: [{ index: 0, relevance_score: 1 }] })
  }
  return Response.json({ data: [{ embedding: [1] }] })
}
