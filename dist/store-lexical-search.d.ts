import type { SqliteDatabase as Database } from "./store-db.js";
import type { LexicalChunkCandidate } from "./types.js";
declare function searchSqliteLexicalCandidates(db: Database, query: string, topK: number, paths?: string[]): LexicalChunkCandidate[];
export { searchSqliteLexicalCandidates };
