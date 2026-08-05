import express, { type Express } from "express";
import cors from "cors";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import router from "./routes";
import { initBot } from "./lib/discord-bot";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── React control panel — serve static build at /panel/ ──────────────────────
// Built files live at artifacts/api-server/public/panel/ relative to repo root.
// When bundled, __dirname = .../artifacts/api-server/dist/ → go one level up.
const panelDir = path.join(__dirname, "..", "public", "panel");
app.use("/panel", express.static(panelDir));
app.use("/panel", (_req, res) => {
  res.sendFile(path.join(panelDir, "index.html"));
});
// Redirect old dashboard URLs → new control panel
app.get("/api/dashboard",       (_req, res) => res.redirect(301, "/panel/"));
app.get("/api/dashboard/*splat", (_req, res) => res.redirect(301, "/panel/"));
app.get("/bot-dashboard",        (_req, res) => res.redirect(301, "/panel/"));
app.get("/bot-dashboard/*splat", (_req, res) => res.redirect(301, "/panel/"));

// Keep old control URL working (redirect to new panel)
app.get("/api/control", (req, res) => {
  const token = req.query.token as string | undefined;
  if (token) {
    res.redirect(301, `/panel/?token=${encodeURIComponent(token)}`);
  } else {
    res.redirect(301, "/panel/");
  }
});

// ── Lightweight health-check ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", ts: Date.now() });
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PIXEL_PR-BOT — Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0e0e1a;
      font-family: 'Segoe UI', sans-serif;
      color: #e0e0f0;
    }
    .card {
      background: #1a1a2e;
      border: 1px solid #3a3a6a;
      border-radius: 16px;
      padding: 48px 56px;
      text-align: center;
      max-width: 460px;
      width: 90%;
      box-shadow: 0 8px 40px rgba(100,80,255,0.15);
    }
    .avatar {
      width: 80px; height: 80px; border-radius: 50%;
      background: linear-gradient(135deg, #7c5cbf, #4a90d9);
      display: flex; align-items: center; justify-content: center;
      font-size: 36px; margin: 0 auto 20px;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; color: #c9b8ff; }
    .tag { font-size: 13px; color: #6b6b9a; margin-bottom: 24px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: #0d2e1a; border: 1px solid #1e6b3a; color: #4ade80;
      border-radius: 999px; padding: 6px 16px; font-size: 13px;
      font-weight: 600; margin-bottom: 28px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .panel-link {
      display: inline-block; margin-top: 16px;
      background: #2a1a5e; border: 1px solid #6d28d9; color: #c4b5fd;
      border-radius: 8px; padding: 10px 24px; font-size: 14px;
      text-decoration: none; font-weight: 600; transition: background 0.2s;
    }
    .panel-link:hover { background: #3b1f7a; }
    .features {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 10px; text-align: left; margin-bottom: 16px;
    }
    .feature {
      background: #12122a; border-radius: 8px; padding: 10px 14px;
      font-size: 13px; color: #a0a0c0; border: 1px solid #2a2a4a;
    }
    .feature span { margin-right: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="avatar">🤖</div>
    <h1>PIXEL_PR-BOT</h1>
    <div class="tag">Discord Bot — API Server</div>
    <div class="badge"><div class="dot"></div>Online &amp; Running</div>
    <div class="features">
      <div class="feature"><span>🛡️</span>Moderation</div>
      <div class="feature"><span>🤖</span>AI Chat (Gemini)</div>
      <div class="feature"><span>⭐</span>Reputation</div>
      <div class="feature"><span>🎮</span>Games</div>
      <div class="feature"><span>🐦</span>X Monitor</div>
      <div class="feature"><span>📻</span>Radio</div>
      <div class="feature"><span>🌍</span>Translation</div>
      <div class="feature"><span>🌅</span>Daily Briefing</div>
    </div>
    <a href="/panel/" class="panel-link">◆ Open Control Panel</a>
  </div>
</body>
</html>`);
});

app.use("/api", router);

// ── Discord bot startup guard ─────────────────────────────────────────────────
const isRender     = !!process.env.RENDER;
const isDev        = process.env.NODE_ENV !== "production";
const devBotEnabled = process.env.BOT_DEV_MODE === "true";

if (isRender || (isDev && devBotEnabled)) {
  initBot().catch(console.error);
} else {
  console.log(
    `[Bot] Discord bot DISABLED on this host ` +
    `(RENDER=${isRender}, NODE_ENV=${process.env.NODE_ENV ?? "unset"}). ` +
    `Set NODE_ENV=development + BOT_DEV_MODE=true to test locally.`
  );
}

export default app;
