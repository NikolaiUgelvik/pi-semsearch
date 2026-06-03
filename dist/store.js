import { buildEmptyIndex } from "./store-index.js";
import { createSqliteIndexStore } from "./store-sqlite.js";
import { rankVectorsByCosine, storeCosineSimilarity } from "./store-vector-search.js";
function createEmptyIndex(input) {
    return buildEmptyIndex(input);
}
function createIndexStore(input) {
    return createSqliteIndexStore(input.cacheDir, input.cacheKey, input.embeddingDimensions);
}
function cosineSimilarity(left, right) {
    return storeCosineSimilarity(left, right);
}
function searchVectors(query, vectors, topK) {
    return rankVectorsByCosine(query, vectors, topK);
}
export { cosineSimilarity, createEmptyIndex, createIndexStore, searchVectors };
