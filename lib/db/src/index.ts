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
  max:                     5,
  min:                     0,           // never keep idle connections — stale connections hang forever
  idleTimeoutMillis:       10_000,      // release idle connections quickly
  connectionTimeoutMillis: 8_000,       // fail fast if DB unreachable
  query_timeout:           12_000,      // client-side kill if a query hangs > 12s
  statement_timeout:       15_000,      // server-side kill for runaway queries
  application_name:        "pixel-pr-bot",
  ssl:                     process.env.NODE_ENV === "production"
                             ? { rejectUnauthorized: false }
                             : false,
});
export const db = drizzle(pool, { schema });

export * from "./schema";

