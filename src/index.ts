import { castPlugin } from "./plugin.js"

export { castChunks, type SyntaxNode } from "./cast.js"
export { languageForPath, parseSource } from "./language.js"
export { createOpenAIClient, type FetchLike } from "./openai.js"
export { parseOptions, type CastPluginOptions } from "./options.js"
export { retrieve } from "./retriever.js"
export { createIndexer } from "./scanner.js"
export { assignSymbolsToChunks, attachTopology, expandWithParentContext, extractSymbols } from "./topology.js"
export type * from "./types.js"

export default castPlugin
