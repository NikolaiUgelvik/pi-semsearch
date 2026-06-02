import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FetchLike } from "./openai.js";
import { retrieveFromStore } from "./retriever.js";
import { createIndexer } from "./scanner.js";
import { createIndexStore } from "./store.js";
interface SemsearchRuntimeDependencies {
    fetch?: FetchLike;
    createStore?: typeof createIndexStore;
    createIndexer?: typeof createIndexer;
    retrieve?: typeof retrieveFromStore;
}
declare function createPiSemsearchExtensionForTest(dependencies?: SemsearchRuntimeDependencies): (pi: ExtensionAPI) => void;
declare const piSemsearchExtension: (pi: ExtensionAPI) => void;
export type { SemsearchRuntimeDependencies };
export { createPiSemsearchExtensionForTest, piSemsearchExtension };
