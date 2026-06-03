import type { SqliteDatabase as Database } from "./store-db.js";
import type { VectorCandidateSearchResult } from "./types.js";
declare function searchSqliteVectorCandidates(db: Database, queryEmbedding: number[], topK: number, paths?: string[]): VectorCandidateSearchResult;
declare function storeCosineSimilarity(left: number[], right: number[]): number;
declare function rankVectorsByCosine(query: number[], vectors: Array<{
    id: string;
    vector: number[];
}>, topK: number): {
    id: string;
    score: number;
}[];
export { rankVectorsByCosine, searchSqliteVectorCandidates, storeCosineSimilarity };
