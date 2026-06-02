import { HYDE_SYSTEM_PROMPT } from "./hyde.js";
const TRAILING_SLASHES_PATTERN = /\/+$/;
const EMBEDDING_RETRIES = 2;
const EMBEDDING_RETRY_DELAY_MS = 10;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
export function createOpenAIClient(options = {}) {
    const request = options.fetch ?? fetch;
    return {
        embed: (input) => embed(request, input),
        embedBatch: (input) => embedBatch(request, input),
        generateHyde: (input) => generateHyde(request, input),
        rerank: (input) => rerank(request, input),
    };
}
async function embed(request, input) {
    const body = await requestEmbeddings(request, input);
    return embeddingFromBody(body);
}
async function embedBatch(request, input) {
    const body = await requestEmbeddings(request, input);
    return embeddingsFromBody(body, input.input.length);
}
async function requestEmbeddings(request, input) {
    const body = await requestJsonWithRetries({
        request,
        url: `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/embeddings`,
        init: {
            method: "POST",
            headers: buildHeaders(input.apiKey),
            body: JSON.stringify({
                model: input.model,
                input: input.input,
                ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
            }),
        },
        label: "Embedding",
        retries: EMBEDDING_RETRIES,
    });
    return body;
}
async function generateHyde(request, input) {
    const body = await requestJson(request, `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/chat/completions`, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
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
    }, "HyDE");
    return hydeContentFromBody(body);
}
async function rerank(request, input) {
    const body = await requestJson(request, `${input.baseURL.replace(TRAILING_SLASHES_PATTERN, "")}/rerank`, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
        body: JSON.stringify({
            model: input.model,
            query: input.query,
            documents: input.documents,
        }),
    }, "Rerank");
    return rerankResultsFromBody(body, input.documents.length);
}
async function requestJson(request, url, init, label) {
    const response = await request(url, init);
    if (!response.ok) {
        throw new Error(`${label} request failed: ${response.status}`);
    }
    return response.json().catch(() => undefined);
}
function requestJsonWithRetries(input) {
    const attemptRequest = async (attempt) => {
        const response = await input.request(input.url, input.init);
        if (response.ok) {
            return response.json().catch(() => undefined);
        }
        if (attempt >= input.retries || !isTransientEmbeddingStatus(response.status)) {
            throw new Error(`${input.label} request failed: ${response.status}`);
        }
        await delay(EMBEDDING_RETRY_DELAY_MS * (attempt + 1));
        return attemptRequest(attempt + 1);
    };
    return attemptRequest(0);
}
function isTransientEmbeddingStatus(status) {
    return status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function embeddingFromBody(body) {
    const embedding = arrayProperty(body, "data")?.[0]?.embedding;
    if (isNumberArray(embedding) && embedding.length > 0) {
        return embedding;
    }
    throw new Error("Embedding response did not include data[0].embedding");
}
function embeddingsFromBody(body, expectedCount) {
    const data = arrayProperty(body, "data");
    if (data?.length !== expectedCount) {
        throw new Error("Embedding response did not include one embedding per input");
    }
    return data.map((item) => {
        const embedding = isRecord(item) ? item.embedding : undefined;
        if (isNumberArray(embedding) && embedding.length > 0) {
            return embedding;
        }
        throw new Error("Embedding response did not include one embedding per input");
    });
}
function hydeContentFromBody(body) {
    const content = arrayProperty(body, "choices")?.[0]?.message?.content;
    if (typeof content === "string" && content.trim() !== "") {
        return content.trim();
    }
    throw new Error("HyDE response did not include choices[0].message.content");
}
function rerankResultsFromBody(body, documentCount) {
    const results = arrayProperty(body, "results");
    if (!results) {
        throw new Error("Rerank response did not include results");
    }
    return results.map((result) => rerankResultFromBody(result, documentCount));
}
function rerankResultFromBody(result, documentCount) {
    const record = isRecord(result) ? result : {};
    const index = record.index;
    const score = record.relevance_score;
    if (!isValidRerankIndex(index, documentCount)) {
        throw new Error("Rerank response included invalid result index");
    }
    if (typeof score !== "number" || Number.isNaN(score)) {
        throw new Error("Rerank response included invalid relevance score");
    }
    return { index, score };
}
function isValidRerankIndex(value, documentCount) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < documentCount;
}
function arrayProperty(value, key) {
    const property = isRecord(value) ? value[key] : undefined;
    return Array.isArray(property) ? property : undefined;
}
function isNumberArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "number");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function buildHeaders(apiKey) {
    return apiKey
        ? {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
        }
        : { "content-type": "application/json" };
}
