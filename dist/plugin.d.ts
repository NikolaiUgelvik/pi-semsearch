import { type Plugin } from "@opencode-ai/plugin";
import { type FetchLike } from "./openai.js";
import { retrieveFromStore } from "./retriever.js";
import { createIndexer } from "./scanner.js";
import { createIndexStore } from "./store.js";
export declare function createCastPluginForTest(dependencies?: {
    fetch?: FetchLike;
    createStore?: typeof createIndexStore;
    createIndexer?: typeof createIndexer;
    retrieve?: typeof retrieveFromStore;
}): Plugin;
export declare const castPlugin: Plugin;
