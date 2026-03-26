import app from "./app";
import { logger } from "./lib/logger";
import { getClient } from "./lib/discord-bot";
import { pool } from "@workspace/db";

// ─── Startup DB migrations (run unconditionally, bot does not need to be online) ─
pool.query(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id        TEXT NOT NULL,
    guild_id       TEXT NOT NULL,
    msg_count      INTEGER NOT NULL DEFAULT 0,
    cmd_count      INTEGER NOT NULL DEFAULT 0,
    hour_counts    INTEGER[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}',
    keywords       JSONB NOT NULL DEFAULT '{}',
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    starter_msgs   INTEGER NOT NULL DEFAULT 0,
    responder_msgs INTEGER NOT NULL DEFAULT 0,
    username       TEXT,
    PRIMARY KEY (user_id, guild_id)
  )
`).then(() =>
  pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS username TEXT`)
).catch((e) => logger.warn({ e }, "[Startup] user_profiles migration skipped"));

// ─── Global Error Shield ──────────────────────────────────────────────────────
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise: String(promise) }, "[Shield] Unhandled promise rejection — bot continues running");
});
process.on("uncaughtException", (err, origin) => {
  logger.error({ err, origin }, "[Shield] Uncaught exception — bot continues running");
});
// ─────────────────────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// ─── DB Keep-alive ────────────────────────────────────────────────────────────
// PostgreSQL drops idle connections after a period of inactivity (Render free
// tier: ~5 min). A lightweight ping every 3 minutes keeps the pool alive with
// a 2-minute safety margin before the 5-minute idle disconnect threshold.
setInterval(async () => {
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    logger.warn({ e }, "[DB] Keep-alive ping failed — pool may reconnect automatically");
  }
}, 3 * 60_000); // every 3 minutes (2-minute safety margin before 5-min idle limit)

// Graceful shutdown — disconnect Discord bot immediately on SIGTERM/SIGINT so the
// old instance stops handling interactions before the new one takes over.
function gracefulShutdown(signal: string) {
  logger.info(`${signal} received — disconnecting bot and shutting down`);
  try {
    const discordClient = getClient();
    if (discordClient) discordClient.destroy();
  } catch {}
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT")); // Ctrl-C in dev
