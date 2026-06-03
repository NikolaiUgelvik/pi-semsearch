import type { SqliteDatabase as Database } from "./store-db.js";
import type { HydrateSqliteChunksInput } from "./store-types.js";
import type { CastIndex, HydratedChunkSet } from "./types.js";
declare function readSqliteIndex(db: Database, cacheKey: string, embeddingDimensions?: number): CastIndex;
declare function readSqliteMetadata(db: Database, cacheKey: string, embeddingDimensions?: number): import("./types.js").IndexMetadata;
declare function hydrateSqliteChunks(input: HydrateSqliteChunksInput): HydratedChunkSet;
export { hydrateSqliteChunks, readSqliteIndex, readSqliteMetadata };
