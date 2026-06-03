import type { SqliteDatabase as Database } from "./db.js";
declare function initializeSchema(db: Database, embeddingDimensions?: number): void;
declare function tableExists(db: Database, table: string): boolean;
export { initializeSchema, tableExists };
