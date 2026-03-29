import app from "./app";
import { logger } from "./lib/logger";
import { getClient, clearOldConversations } from "./lib/discord-bot";
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

// ─── HTTP server hardening ─────────────────────────────────────────────────
// keepAliveTimeout > proxy idle timeout prevents ECONNRESET under concurrent pings.
// headersTimeout must be > keepAliveTimeout (Node.js requirement).
// maxConnections caps file-descriptor usage under sustained load.
server.keepAliveTimeout  = 65_000;  // 65s — above most proxy 60s idle timeouts
server.headersTimeout    = 66_000;  // must exceed keepAliveTimeout
(server as any).maxConnections = 200; // hard cap against connection exhaustion

// Keep-alive is handled by discord-bot.ts → startKeepAlive() (pings every 10 min).

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

// ─── Memory watchdog ──────────────────────────────────────────────────────────
// Render free tier: 512 MB total RAM / 384 MB heap cap.
// Thresholds lowered by 50 MB each to give more headroom before OOM kill.
// Now also monitors RSS (total process memory) — Render kills at 512 MB RSS.
//   RSS ≥ 460 MB → DANGER: voluntary exit before Render OOM-kills us (exit 1 → instant restart)
//   heap ≥ 300 MB → critical: force GC + evict
//   heap ≥ 250 MB → warning: evict 5 min idle
//   heap ≥ 200 MB → elevated: evict 15 min idle
setInterval(() => {
  const mem  = process.memoryUsage();
  const heap = Math.round(mem.heapUsed  / 1024 / 1024);
  const rss  = Math.round(mem.rss       / 1024 / 1024);
  const ext  = Math.round(mem.external  / 1024 / 1024);

  // ── RSS guard: voluntary restart before Render OOM-kills us ────────────────
  // OOM kill = no clean-up, no SIGTERM, Render restart takes longer.
  // Voluntary exit(1) = Render restarts immediately with a clean process.
  if (rss >= 460) {
    logger.error({ heap, rss, ext }, `[Memory] ☠️ RSS ${rss}MB — approaching Render OOM limit (512MB). Voluntary restart.`);
    process.exit(1);
  }

  if (heap >= 300) {
    const cleared = clearOldConversations(2 * 60_000);
    if (typeof (global as any).gc === "function") (global as any).gc();
    logger.warn({ heap, rss, ext, cleared }, `[Memory] 🚨 CRITICAL ${heap}MB heap — GC + emergency clear: ${cleared} convos freed`);
  } else if (heap >= 250) {
    const cleared = clearOldConversations(5 * 60_000);
    if (typeof (global as any).gc === "function") (global as any).gc();
    logger.warn({ heap, rss, ext, cleared }, `[Memory] ⚠️  HIGH ${heap}MB heap — cleared ${cleared} inactive convos`);
  } else if (heap >= 200) {
    const cleared = clearOldConversations(15 * 60_000);
    if (cleared > 0) {
      logger.info({ heap, rss, ext, cleared }, `[Memory] 🟡 ELEVATED ${heap}MB heap — pre-emptive clear: ${cleared} convos freed`);
    } else {
      logger.info({ heap, rss, ext }, `[Memory] 🟡 ELEVATED ${heap}MB heap | ${rss}MB RSS`);
    }
  } else {
    logger.info({ heap, rss, ext }, `[Memory] ✅ ${heap}MB heap | ${rss}MB RSS`);
  }
}, 30_000); // every 30 s (was 60 s) — catch spikes faster

// ─── Proactive GC every 5 minutes ─────────────────────────────────────────────
// Forces V8 to collect garbage proactively even when heap looks normal.
// Prevents slow creep accumulation that causes sudden OOM during burst sends.
setInterval(() => {
  if (typeof (global as any).gc === "function") {
    (global as any).gc();
  }
}, 5 * 60_000);

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
