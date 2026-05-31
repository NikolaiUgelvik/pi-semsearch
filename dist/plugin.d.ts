import { type Plugin } from "@opencode-ai/plugin";
import { type FetchLike } from "./openai.js";
import { retrieve } from "./retriever.js";
import { createIndexer } from "./scanner.js";
import { createIndexStore } from "./store.js";
export declare function createCastPluginForTest(dependencies?: {
    fetch?: FetchLike;
    createStore?: typeof createIndexStore;
    createIndexer?: typeof createIndexer;
    retrieve?: typeof retrieve;
}): Plugin;
export declare const castPlugin: Plugin;
