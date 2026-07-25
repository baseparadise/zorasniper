import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Lazy initialization: do NOT throw at module load time.
// The server must be able to start and pass healthchecks even when
// DATABASE_URL is not yet configured. Errors will surface naturally
// at query time when the pool tries to connect.
let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getPool(): pg.Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL must be set. Did you forget to provision a database?",
      );
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

// Proxy so existing imports (`db.select()`, `pool.query()`) keep working
// without any changes to callers.
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    const instance = getDb();
    const val = (instance as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? val.bind(instance) : val;
  },
});

export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    const instance = getPool();
    const val = (instance as Record<string | symbol, unknown>)[prop];
    return typeof val === "function" ? val.bind(instance) : val;
  },
});

export * from "./schema";
