import type { LexicalChunkCandidate } from "../shared/types.js";
import type { SqliteDatabase as Database } from "./db.js";
declare function searchSqliteLexicalCandidates(db: Database, query: string, topK: number, paths?: string[]): LexicalChunkCandidate[];
export { searchSqliteLexicalCandidates };
