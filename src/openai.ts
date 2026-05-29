export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function createOpenAIClient(options: { fetch?: FetchLike } = {}) {
  const request = options.fetch ?? fetch

  return {
    async embed(input: {
      baseURL: string
      apiKey?: string
      model: string
      dimensions?: number
      input: string
    }) {
      const response = await request(`${input.baseURL.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
        body: JSON.stringify({
          model: input.model,
          input: input.input,
          ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
        }),
      })

      if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`)

      const body = await response.json().catch(() => undefined)
      const embedding =
        typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)
          ? body.data[0]?.embedding
          : undefined
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === "number")) {
        throw new Error("Embedding response did not include data[0].embedding")
      }
      return embedding
    },

    async generateHyde(input: { baseURL: string; apiKey?: string; model: string; query: string }) {
      const response = await request(`${input.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "system",
              content: "Produce a concise hypothetical code search target for the user's repository question.",
            },
            { role: "user", content: input.query },
          ],
          temperature: 0,
        }),
      })

      if (!response.ok) throw new Error(`HyDE request failed: ${response.status}`)

      const body = await response.json().catch(() => undefined)
      const content =
        typeof body === "object" && body !== null && "choices" in body && Array.isArray(body.choices)
          ? body.choices[0]?.message?.content
          : undefined
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("HyDE response did not include choices[0].message.content")
      }
      return content.trim()
    },
  }
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey
    ? {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      }
    : { "content-type": "application/json" }
}
