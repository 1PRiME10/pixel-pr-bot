import express, { type Express } from "express";
import cors from "cors";
import router from "./routes";
import { initBot } from "./lib/discord-bot";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Redirect old dashboard URLs → Watchdog control panel
app.get("/api/dashboard", (_req, res) => res.redirect(301, "/api/control"));
app.get("/api/dashboard/*splat", (_req, res) => res.redirect(301, "/api/control"));
app.get("/bot-dashboard", (_req, res) => res.redirect(301, "/api/control"));
app.get("/bot-dashboard/*splat", (_req, res) => res.redirect(301, "/api/control"));

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
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: linear-gradient(135deg, #7c5cbf, #4a90d9);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 36px;
      margin: 0 auto 20px;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; color: #c9b8ff; }
    .tag { font-size: 13px; color: #6b6b9a; margin-bottom: 24px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #0d2e1a;
      border: 1px solid #1e6b3a;
      color: #4ade80;
      border-radius: 999px;
      padding: 6px 16px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 28px;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .features {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      text-align: left;
    }
    .feature {
      background: #12122a;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      color: #a0a0c0;
      border: 1px solid #2a2a4a;
    }
    .feature span { margin-right: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="avatar">🤖</div>
    <h1>PIXEL_PR-BOT</h1>
    <div class="tag">Discord Bot — API Server</div>
    <div class="badge">
      <div class="dot"></div>
      Online &amp; Running
    </div>
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
  </div>
</body>
</html>`);
});

app.use("/api", router);

// ── Discord bot startup guard ────────────────────────────────────────────────
// RENDER env var is auto-set by Render.com — never present on Replit.
// Rules:
//   • On Render (RENDER=true)          → always start the bot (production)
//   • On Replit/local, NODE_ENV=dev,   → only start if BOT_DEV_MODE=true (testing)
//   • On Replit/local, NODE_ENV=prod   → NEVER start (prevents double-replies when
//                                        Render is the live deployment)
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
