import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { env } from "node:process";
import { formatThrownError } from "./extension-errors.js";
import { parseOptions } from "./options.js";
async function loadPiSemsearchOptions(worktree) {
    return parseOptions(await loadConfigFile(worktree));
}
async function loadConfigFile(worktree) {
    return (await readFirstConfigCandidate(configCandidates(worktree))) ?? envOptions();
}
function configCandidates(worktree) {
    return [
        env.PI_SEMSEARCH_CONFIG,
        path.join(worktree, ".pi", "semsearch.json"),
        path.join(worktree, "semsearch.pi.json"),
        path.join(homedir(), ".pi", "semsearch.json"),
    ].filter((candidate) => Boolean(candidate));
}
async function readFirstConfigCandidate(candidates) {
    const [candidate, ...remaining] = candidates;
    if (!candidate) {
        return;
    }
    try {
        return JSON.parse(await readFile(candidate, "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw new Error(`Failed to read pi-semsearch config ${candidate}: ${formatThrownError(error)}`);
        }
        return readFirstConfigCandidate(remaining);
    }
}
function envOptions() {
    return {
        embedding: envEmbeddingOptions(),
        hyde: envHydeOptions(),
        rerank: envRerankOptions(),
    };
}
function envEmbeddingOptions() {
    return {
        baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_EMBEDDING_BASE_URL"),
        apiKeyEnv: env.PI_SEMSEARCH_EMBEDDING_API_KEY_ENV ?? "OPENAI_API_KEY",
        model: env.PI_SEMSEARCH_EMBEDDING_MODEL,
        dimensions: numberEnv("PI_SEMSEARCH_EMBEDDING_DIMENSIONS"),
    };
}
function envHydeOptions() {
    const model = env.PI_SEMSEARCH_HYDE_MODEL;
    return model
        ? {
            baseURL: envOpenAiBaseUrl("PI_SEMSEARCH_HYDE_BASE_URL"),
            apiKeyEnv: env.PI_SEMSEARCH_HYDE_API_KEY_ENV ?? "OPENAI_API_KEY",
            model,
            threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD"),
        }
        : { threshold: numberEnv("PI_SEMSEARCH_HYDE_THRESHOLD") };
}
function envRerankOptions() {
    const baseUrl = env.PI_SEMSEARCH_RERANK_BASE_URL;
    const model = env.PI_SEMSEARCH_RERANK_MODEL;
    return baseUrl && model
        ? {
            baseURL: baseUrl,
            apiKeyEnv: env.PI_SEMSEARCH_RERANK_API_KEY_ENV,
            model,
        }
        : undefined;
}
function envOpenAiBaseUrl(key) {
    return env[key] ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}
function numberEnv(key) {
    const value = env[key];
    return value ? Number(value) : undefined;
}
export { loadPiSemsearchOptions };
