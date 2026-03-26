import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getClient, getStartTime } from "../lib/discord-bot.js";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const client   = getClient();
  const uptime   = getStartTime();
  const botReady = !!(client?.isReady());
  const wsPing   = client?.ws?.ping ?? -1;

  // ── DB connectivity check — measures round-trip time ─────────────────────
  let dbOk     = false;
  let dbPingMs = -1;
  try {
    const t0 = Date.now();
    await pool.query("SELECT 1");
    dbPingMs = Date.now() - t0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const data = HealthCheckResponse.parse({ status: "ok" });

  res.json({
    ...data,
    bot: {
      connected:    botReady,
      ws_ping_ms:   wsPing,
      uptime_since: uptime?.toISOString() ?? null,
    },
    db: {
      ok:      dbOk,
      ping_ms: dbPingMs,
    },
  });
});

export default router;
