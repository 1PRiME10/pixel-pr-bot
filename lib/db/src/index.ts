import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     5,          // 5 concurrent connections — enough for all features (was 20 → wasted ~75 MB RAM)
  min:                     1,          // keep 1 warm connection alive at all times
  idleTimeoutMillis:       60_000,     // release idle connections after 60s (was 30s — less churn)
  connectionTimeoutMillis: 5_000,      // fail fast if DB is unreachable
  statement_timeout:       15_000,     // kill queries that run > 15s (prevents blocking)
  application_name:        "pixel-pr-bot",
});
export const db = drizzle(pool, { schema });

export * from "./schema";
