import type { CastIndex, HydratedChunkSet } from "../shared/types.js";
import type { SqliteDatabase as Database } from "./db.js";
import type { HydrateSqliteChunksInput } from "./types.js";
declare function readSqliteIndex(db: Database, cacheKey: string, embeddingDimensions?: number): CastIndex;
declare function readSqliteMetadata(db: Database, cacheKey: string, embeddingDimensions?: number): import("../shared/types.js").IndexMetadata;
declare function hydrateSqliteChunks(input: HydrateSqliteChunksInput): HydratedChunkSet;
export { hydrateSqliteChunks, readSqliteIndex, readSqliteMetadata };
