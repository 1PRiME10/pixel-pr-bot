// ─── Bot Control Panel ─────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { cpSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runBackup, getBackupStatus } from "../lib/github-backup.js";
import { pool } from "@workspace/db";
import { getClient, getStartTime, stopBot, startBot, isBotPaused } from "../lib/discord-bot.js";
import { getRegisteredCommandNames } from "../lib/plugin-registrar.js";
import { FEATURE_REGISTRY, setFeatureEnabled, isFeatureEnabled } from "../lib/feature-registry.js";

const router: IRouter = Router();

const TOKEN   = process.env.BOT_CONTROL_TOKEN ?? "";
const _dir    = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(_dir, "..", "..");

let backupJob: { running: boolean; logs: string[]; startedAt: string | null } = {
  running: false, logs: [], startedAt: null,
};

function requireToken(req: any, res: any, next: any) {
  const supplied = req.headers["x-control-token"] ?? req.query.token ?? req.body?.token;
  if (!TOKEN || supplied !== TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ─── GET /api/control ──────────────────────────────────────────────────────────
router.get("/control", (req: any, res: any) => {
  const token      = (req.query.token as string) ?? "";
  const authed     = !!(TOKEN && token === TOKEN);
  const ghRepo     = process.env.GITHUB_BACKUP_REPO ?? "1PRiME10/pixel-pr-backup";
  const ghOk       = !!(process.env.GITHUB_BACKUP_TOKEN && ghRepo);
  const safeToken  = authed ? token.replace(/\\/g, "\\\\").replace(/'/g, "\\'") : "";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PIXEL_PR Control Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@300;400;600&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0918;color:#c8c0e0;font-family:'Inter',sans-serif;font-size:14px;padding:14px;min-height:100vh}
h1{color:#a78bfa;font-family:'Share Tech Mono',monospace;font-size:15px;text-align:center;margin-bottom:14px;letter-spacing:2px}
.status-bar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;justify-content:center}
.badge{padding:5px 12px;border-radius:20px;font-size:11px;font-family:'Share Tech Mono',monospace;font-weight:600;white-space:nowrap}
.bg{background:#14532d;color:#4ade80;border:1px solid #16a34a}
.br{background:#450a0a;color:#f87171;border:1px solid #dc2626}
.bb{background:#0c1a4a;color:#60a5fa;border:1px solid #2563eb}
.bp{background:#2e1065;color:#c084fc;border:1px solid #7c3aed}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;justify-content:center}
.btn{padding:10px 18px;border:none;border-radius:8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:12px;font-weight:600;transition:opacity .15s;-webkit-tap-highlight-color:rgba(0,0,0,0)}
.btn:active{opacity:.6}
.btn-purple{background:#6d28d9;color:#fff}
.btn-blue{background:#1d4ed8;color:#fff}
.btn-red{background:#b91c1c;color:#fff}
.btn-green{background:#15803d;color:#fff}
.uid{font-family:'Share Tech Mono',monospace;color:#c084fc;font-size:12px}
.uname{font-family:'Share Tech Mono',monospace;color:#55507a;font-size:10px;display:block;margin-top:1px}
section{background:#0e0c1e;border:1px solid #1e1c35;border-radius:10px;margin-bottom:14px;overflow:hidden}
.sec-hd{padding:10px 14px;background:#14123a;font-family:'Share Tech Mono',monospace;font-size:12px;color:#a78bfa;border-bottom:1px solid #1e1c35;letter-spacing:1px}
table{width:100%;border-collapse:collapse}
th{padding:7px 10px;text-align:left;background:#0a091a;color:#55507a;font-size:10px;font-family:'Share Tech Mono',monospace;font-weight:normal;border-bottom:1px solid #1a1830;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #13111f;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.025)}
.n{font-family:'Share Tech Mono',monospace;color:#c084fc}
.m{color:#55507a;font-size:11px}
.logbox{background:#060510;padding:10px 14px;font-family:'Share Tech Mono',monospace;font-size:11px;border-top:1px solid #1a1830;min-height:32px}
.ok{color:#4ade80}.er{color:#f87171}
.empty{color:#55507a;font-family:'Share Tech Mono',monospace;padding:16px;text-align:center;font-size:11px}
input[type=text]{background:#0f0e20;border:1px solid #2a2545;color:#ccc;padding:8px 12px;border-radius:6px;font-size:13px;width:100%;margin-bottom:8px;outline:none}
input[type=text]:focus{border-color:#7c3aed}
.auth-box{padding:12px}
</style>
</head>
<body>
<h1>◆ PIXEL_PR CONTROL PANEL ◆</h1>

${!authed ? `
<section>
  <div class="sec-hd">◈ AUTHENTICATION REQUIRED</div>
  <div class="auth-box">
    <input type="text" id="tok-inp" placeholder="Enter control token..." autocomplete="off"/>
    <div class="controls" style="margin-bottom:0">
      <button class="btn btn-purple" onclick="setTok()">◆ AUTHENTICATE</button>
    </div>
  </div>
</section>` : ""}

<div class="status-bar" id="sbar"><span class="badge bp">◈ LOADING...</span></div>

${authed ? `
<div class="controls">
  <button class="btn btn-red" id="stopBtn" onclick="doStop()">⏹ STOP BOT</button>
  <button class="btn btn-green" id="startBtn" onclick="doStart()" style="display:none">▶ START BOT</button>
  <button class="btn btn-purple" onclick="doRestart()">↺ REFRESH BOT</button>
  ${ghOk ? `<button class="btn btn-blue" onclick="doBackup()">☁ BACKUP</button>` : ""}
</div>
<div class="logbox ok" id="logbox">Ready.</div>
` : ""}

<section>
  <div class="sec-hd">◉ USERS — Top 100 by Messages</div>
  <div id="utbl"><div class="empty">LOADING...</div></div>
</section>

<section>
  <div class="sec-hd">◎ SERVERS</div>
  <div id="stbl"><div class="empty">LOADING...</div></div>
</section>

<script>
var TOK = '${safeToken}';
var BASE = (function(){
  var p = window.location.pathname;
  var i = p.indexOf('/api/control');
  return i !== -1 ? p.slice(0, i) : '';
})();

function tok(){ var el = document.getElementById('tok-inp'); return (el ? el.value.trim() : '') || TOK; }
function aurl(p){ return BASE + '/api' + p; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(n){ return Number(n||0).toLocaleString(); }
function ago(ts){
  if(!ts) return '—';
  var d = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if(d < 1) return 'just now';
  if(d < 60) return d + 'm ago';
  if(d < 1440) return Math.floor(d/60) + 'h ago';
  return Math.floor(d/1440) + 'd ago';
}
function log(msg, err){
  var el = document.getElementById('logbox');
  if(!el) return;
  el.textContent = '[' + new Date().toTimeString().slice(0,8) + '] ' + msg;
  el.className = 'logbox ' + (err ? 'er' : 'ok');
}

async function api(path, method, body){
  var opts = { method: method||'GET', headers: { 'X-Control-Token': tok(), 'Content-Type': 'application/json' } };
  if(body) opts.body = JSON.stringify(body);
  var r = await fetch(aurl(path), opts);
  if(!r.ok) throw new Error('HTTP ' + r.status + (r.status===401?' (wrong token)':''));
  return r.json();
}

function setTok(){
  var t = (document.getElementById('tok-inp')||{}).value||'';
  t = t.trim();
  if(!t){ alert('Enter the control token'); return; }
  TOK = t;
  loadAll();
}

async function loadStatus(){
  try {
    var d = await fetch(aurl('/stats')).then(function(r){ return r.json(); });
    var html = [
      '<span class="badge '+(d.discordOnline?'bg':'br')+'">'+(d.discordOnline?'● ONLINE':'● OFFLINE')+'</span>',
      '<span class="badge bb">▣ '+fmt(d.totalServers)+' servers</span>',
      '<span class="badge bp">◉ '+fmt(d.totalUsers)+' members</span>',
      '<span class="badge bb">✉ '+fmt(d.totalMessages)+' msgs</span>',
      (d.uptime && d.uptime!=='—') ? '<span class="badge bg">⏱ '+esc(d.uptime)+'</span>' : '',
    ].join('');
    document.getElementById('sbar').innerHTML = html;
    // Update stop/start button visibility based on bot status
    if(tok()){
      try {
        var ps = await api('/control/bot-status');
        var stopped = ps && ps.paused;
        var stopBtn = document.getElementById('stopBtn');
        var startBtn = document.getElementById('startBtn');
        if(stopBtn) stopBtn.style.display = stopped ? 'none' : '';
        if(startBtn) startBtn.style.display = stopped ? '' : 'none';
      } catch(e2){ /* not authed yet */ }
    }
  } catch(e){
    document.getElementById('sbar').innerHTML = '<span class="badge br">◈ STATUS ERROR</span>';
  }
}

async function loadUsers(){
  try {
    var rows = await api('/control/users-list?filter=msgs');
    if(!rows || !rows.length){
      document.getElementById('utbl').innerHTML = '<div class="empty">No users found.</div>';
      return;
    }
    var h = '<table><thead><tr><th>#</th><th>User</th><th>Server</th><th>Msgs</th><th>Cmds</th><th>Last Seen</th></tr></thead><tbody>';
    for(var i=0;i<rows.length;i++){
      var u = rows[i];
      var userCell = '<span class="uid">'+esc(u.userId)+'</span>';
      if(u.username && u.username !== u.userId){
        userCell += '<span class="uname">@'+esc(u.username)+'</span>';
      }
      h += '<tr><td class="m">'+(i+1)+'</td><td>'+userCell+'</td><td class="m">'+esc(u.guildName||u.guildId)+'</td><td class="n">'+fmt(u.msgCount)+'</td><td class="n">'+fmt(u.cmdCount)+'</td><td class="m">'+ago(u.lastSeen)+'</td></tr>';
    }
    h += '</tbody></table>';
    document.getElementById('utbl').innerHTML = h;
  } catch(e){
    document.getElementById('utbl').innerHTML = '<div class="empty er">⚠ '+esc(e.message)+(tok()?'':' — enter token first')+'</div>';
  }
}

async function loadServers(){
  try {
    var rows = await api('/control/servers-list');
    if(!rows || !rows.length){
      document.getElementById('stbl').innerHTML = '<div class="empty">No servers found.</div>';
      return;
    }
    var h = '<table><thead><tr><th>#</th><th>Server Name</th><th>Members</th><th>Joined</th></tr></thead><tbody>';
    for(var i=0;i<rows.length;i++){
      var g = rows[i];
      h += '<tr><td class="m">'+(i+1)+'</td><td>'+esc(g.name)+'</td><td class="n">'+fmt(g.memberCount)+'</td><td class="m">'+ago(g.joinedAt)+'</td></tr>';
    }
    h += '</tbody></table>';
    document.getElementById('stbl').innerHTML = h;
  } catch(e){
    document.getElementById('stbl').innerHTML = '<div class="empty er">⚠ '+esc(e.message)+(tok()?'':' — enter token first')+'</div>';
  }
}

function loadAll(){ loadStatus(); loadUsers(); loadServers(); }

async function doRestart(){
  if(!tok()){ alert('Not authenticated'); return; }
  if(!window.confirm('Refresh the bot? It will reconnect in ~15 seconds.')) return;
  try { log('↺ Refreshing...'); await api('/control/restart','POST'); log('✓ Refresh sent — bot back in ~15s'); setTimeout(loadStatus, 18000); }
  catch(e){ log('⚠ '+e.message, true); }
}

async function doStop(){
  if(!tok()){ alert('Not authenticated'); return; }
  if(!window.confirm('Stop the bot? It will go offline until you press Start.')) return;
  try {
    log('⏹ Stopping bot...');
    await api('/control/bot-stop','POST');
    log('✓ Bot stopped');
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('startBtn').style.display = '';
  } catch(e){ log('⚠ '+e.message, true); }
}

async function doStart(){
  if(!tok()){ alert('Not authenticated'); return; }
  try {
    log('▶ Starting bot...');
    await api('/control/bot-start','POST');
    log('✓ Bot started — connecting to Discord...');
    document.getElementById('stopBtn').style.display = '';
    document.getElementById('startBtn').style.display = 'none';
    setTimeout(loadStatus, 8000);
  } catch(e){ log('⚠ '+e.message, true); }
}

async function doBackup(){
  if(!tok()){ alert('Not authenticated'); return; }
  try { log('☁ Starting backup...'); await api('/control/github-backup','POST'); log('✓ Backup running in background'); }
  catch(e){ log('⚠ '+e.message, true); }
}

async function doRestore(){
  if(!tok()){ alert('Not authenticated'); return; }
  if(!window.confirm('Restore previous build and restart?')) return;
  try {
    log('◇ Restoring...');
    var d = await api('/control/restore','POST');
    log('✓ '+(d.message||'Restored'));
  } catch(e){ log('⚠ '+e.message, true); }
}

document.addEventListener('DOMContentLoaded', function(){
  loadAll();
  setInterval(loadStatus, 30000);
});
</script>
</body>
</html>`);
});

// ─── GET /api/control/health-detail ───────────────────────────────────────────
router.get("/control/health-detail", requireToken, async (_req: any, res: any) => {
  const mem = process.memoryUsage();
  const dbT0 = Date.now();
  let dbOk = false, dbPingMs = -1;
  try { await pool.query("SELECT 1"); dbPingMs = Date.now() - dbT0; dbOk = true; } catch { /* db unreachable */ }
  const botClient = getClient();
  const botReady  = !!botClient?.isReady();
  const wsPing    = botClient?.ws?.ping ?? -1;
  const { rows: errRows } = await pool.query(
    `SELECT COUNT(*) AS n FROM self_heal_errors WHERE occurred_at >= NOW() - INTERVAL '24 hours'`,
  ).catch(() => ({ rows: [{ n: "0" }] }));
  const { rows: errLast } = await pool.query(
    `SELECT occurred_at, error_msg FROM self_heal_errors ORDER BY occurred_at DESC LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  res.json({
    bot: { ready: botReady, wsPing },
    db:  { ok: dbOk, pingMs: dbPingMs },
    memory: {
      heapUsedMb:  Math.round(mem.heapUsed  / 1_048_576),
      heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
      rssMb:       Math.round(mem.rss       / 1_048_576),
    },
    errors24h: parseInt(errRows[0]?.n ?? "0", 10),
    lastError: errLast[0] ?? null,
  });
});

// ─── GET /api/control/errors-list ─────────────────────────────────────────────
router.get("/control/errors-list", requireToken, async (req: any, res: any) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 200);
  const { rows } = await pool.query(
    `SELECT id, error_type, error_msg, context, ai_category, ai_analysis, ai_fix,
            auto_fixed, fix_action, guild_id, occurred_at
     FROM self_heal_errors ORDER BY occurred_at DESC LIMIT $1`,
    [limit],
  ).catch(() => ({ rows: [] }));
  res.json(rows);
});

// ─── GET /api/control/github-status ───────────────────────────────────────────
router.get("/control/github-status", requireToken, (_req: any, res: any) => {
  res.json({ running: backupJob.running, startedAt: backupJob.startedAt, logs: backupJob.logs, message: getBackupStatus() });
});

// ─── POST /api/control/github-backup ──────────────────────────────────────────
router.post("/control/github-backup", requireToken, async (_req: any, res: any) => {
  if (backupJob.running) { res.json({ running: true, message: "⏳ Backup already running." }); return; }
  backupJob = { running: true, logs: ["☁️ Backup started..."], startedAt: new Date().toISOString() };
  res.json({ running: true, message: "☁️ Backup started in background." });
  const push = (msg: string) => { backupJob.logs.push(msg); return Promise.resolve(); };
  try   { await runBackup(push, push); }
  catch (e: any) { backupJob.logs.push("❌ Error: " + e.message); }
  finally { backupJob.running = false; }
});

// ─── GET /api/control/bot-status ──────────────────────────────────────────────
router.get("/control/bot-status", requireToken, (_req: any, res: any) => {
  res.json({ paused: isBotPaused(), online: !!getClient()?.isReady() });
});

// ─── POST /api/control/bot-stop ───────────────────────────────────────────────
router.post("/control/bot-stop", requireToken, async (_req: any, res: any) => {
  await stopBot();
  res.json({ message: "🛑 Bot stopped." });
});

// ─── POST /api/control/bot-start ──────────────────────────────────────────────
router.post("/control/bot-start", requireToken, async (_req: any, res: any) => {
  res.json({ message: "▶ Bot starting..." });
  res.once("finish", () => { startBot().catch(console.error); });
});

// ─── POST /api/control/restart ────────────────────────────────────────────────
router.post("/control/restart", requireToken, async (_req: any, res: any) => {
  res.json({ message: "↺ REFRESHING — bot will return in ~15s." });
  res.once("finish", () => {
    console.log("[Control] 🔄 Manual refresh triggered via control panel");
    setTimeout(() => process.exit(0), 200);
  });
  setTimeout(() => process.exit(0), 2_000);
});

// ─── POST /api/control/restore ────────────────────────────────────────────────
router.post("/control/restore", requireToken, async (_req: any, res: any) => {
  const distDir   = resolve(API_DIR, "dist");
  const backupDir = resolve(API_DIR, "dist.backup");
  if (!existsSync(backupDir)) { res.status(404).json({ message: "❌ No backup found (dist.backup/ missing)." }); return; }
  try {
    mkdirSync(distDir, { recursive: true });
    cpSync(backupDir, distDir, { recursive: true, force: true });
    console.log("[Control] 💾 dist.backup/ → dist/ restored");
    res.json({ message: "✅ Restored. Restarting..." });
    setTimeout(() => process.exit(0), 400);
  } catch (e: any) { res.status(500).json({ message: "❌ Restore failed: " + e.message }); }
});

// ─── GET /api/stats — Public stats ────────────────────────────────────────────
router.get("/stats", async (_req: any, res: any) => {
  try {
    const [msgs, cmds, new7, active7] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(msg_count),0) AS n FROM user_profiles`),
      pool.query(`SELECT COALESCE(SUM(cmd_count),0) AS n FROM user_profiles`),
      pool.query(`SELECT COUNT(DISTINCT user_id) AS n FROM user_profiles WHERE first_seen >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(DISTINCT user_id) AS n FROM user_profiles WHERE last_seen  >= NOW() - INTERVAL '7 days'`),
    ]);
    const botClient     = getClient();
    const botStart      = getStartTime();
    const discordOnline = !!botClient?.isReady();
    let totalServers = 0, totalUsers = 0;
    if (botClient?.isReady()) {
      totalServers = botClient.guilds.cache.size;
      totalUsers   = botClient.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0);
    }
    let uptime = "—";
    if (botStart) {
      const ms = Date.now() - botStart.getTime();
      const h  = Math.floor(ms / 3_600_000);
      const m  = Math.floor((ms % 3_600_000) / 60_000);
      uptime = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    res.json({
      totalUsers, totalServers,
      totalMessages: parseInt(msgs.rows[0].n, 10),
      totalCommands: parseInt(cmds.rows[0].n, 10),
      newUsers7d:    parseInt(new7.rows[0].n, 10),
      activeUsers7d: parseInt(active7.rows[0].n, 10),
      discordOnline, uptime,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/control/servers-list ────────────────────────────────────────────
router.get("/control/servers-list", requireToken, (_req: any, res: any) => {
  const botClient = getClient();
  if (!botClient?.isReady()) { res.json([]); return; }
  const guilds = [...botClient.guilds.cache.values()]
    .sort((a, b) => b.memberCount - a.memberCount)
    .map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount, iconUrl: g.iconURL({ size: 64 }) ?? null, joinedAt: g.joinedAt?.toISOString() ?? null }));
  res.json(guilds);
});

// ─── GET /api/control/features ────────────────────────────────────────────────
router.get("/control/features", requireToken, (_req: any, res: any) => {
  try {
    const features = FEATURE_REGISTRY.map((f) => ({
      key: f.key, name: f.name, description: f.description, category: f.category,
      essential: f.essential ?? false, defaultEnabled: f.defaultEnabled, enabled: isFeatureEnabled(f.key),
    }));
    res.json(features);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/control/features/:key/toggle ───────────────────────────────────
router.post("/control/features/:key/toggle", requireToken, async (req: any, res: any) => {
  const { key } = req.params;
  const { enabled } = req.body as { enabled: boolean };
  const feature = FEATURE_REGISTRY.find((f) => f.key === key);
  if (!feature) { res.status(404).json({ error: "Feature not found" }); return; }
  if (feature.essential) { res.status(403).json({ error: "Essential features cannot be toggled" }); return; }
  try { await setFeatureEnabled(key, enabled); res.json({ ok: true, key, enabled }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/control/users-list ──────────────────────────────────────────────
router.get("/control/users-list", requireToken, async (req: any, res: any) => {
  try {
    const botClient = getClient();
    const filter: string = (req.query.filter as string) ?? "msgs";
    let sql = "";
    const cols = `user_id AS "userId", guild_id AS "guildId", username, msg_count AS "msgCount", cmd_count AS "cmdCount", last_seen AS "lastSeen"`;
    if (filter === "cmds") {
      sql = `SELECT ${cols} FROM user_profiles ORDER BY cmd_count DESC LIMIT 100`;
    } else if (filter === "new7") {
      sql = `SELECT ${cols} FROM user_profiles WHERE first_seen >= NOW() - INTERVAL '7 days' ORDER BY first_seen DESC LIMIT 100`;
    } else if (filter === "active7") {
      sql = `SELECT ${cols} FROM user_profiles WHERE last_seen >= NOW() - INTERVAL '7 days' ORDER BY last_seen DESC LIMIT 100`;
    } else {
      sql = `SELECT ${cols} FROM user_profiles ORDER BY msg_count DESC LIMIT 100`;
    }
    const { rows } = await pool.query(sql);

    if (rows.length > 0) {
      // Step 1: fill from bot cache for any row still missing a username
      for (const r of rows) {
        if (!r.username) {
          r.username = botClient?.users.cache.get(r.userId)?.username ?? null;
        }
      }

      // Step 2: batch-fetch remaining unknowns from Discord API (max 25 at a time)
      if (botClient?.isReady()) {
        const unknown = [...new Set(rows.filter((r: any) => !r.username).map((r: any) => r.userId))];
        const fetched = new Map<string, string>();
        for (let i = 0; i < unknown.length; i += 25) {
          const batch = unknown.slice(i, i + 25);
          await Promise.all(batch.map(async (uid: string) => {
            try {
              const user = await botClient.users.fetch(uid);
              fetched.set(uid, user.username);
            } catch { /* user may have left all mutual servers */ }
          }));
        }
        // Backfill into the result rows
        for (const r of rows) {
          if (!r.username && fetched.has(r.userId)) {
            r.username = fetched.get(r.userId)!;
          }
        }
        // Persist fetched usernames to DB so future loads are instant
        if (fetched.size > 0) {
          const vals = [...fetched.entries()];
          pool.query(
            `UPDATE user_profiles SET username = v.username
             FROM (SELECT UNNEST($1::text[]) AS user_id, UNNEST($2::text[]) AS username) v
             WHERE user_profiles.user_id = v.user_id AND user_profiles.username IS NULL`,
            [vals.map(([id]) => id), vals.map(([, name]) => name)],
          ).catch(() => {});
        }
      }

      res.json(rows.map((r: any) => ({
        ...r,
        guildName: botClient?.guilds.cache.get(r.guildId)?.name ?? r.guildId,
      })));
      return;
    }

    if (!botClient?.isReady()) { res.json([]); return; }
    const members: any[] = [];
    for (const guild of botClient.guilds.cache.values()) {
      let col = guild.members.cache;
      if (col.size < 2 && guild.memberCount <= 1000) {
        try { await guild.members.fetch({ limit: 1000 }); col = guild.members.cache; } catch {}
      }
      for (const m of col.values()) {
        if (m.user.bot) continue;
        members.push({ userId: m.user.id, username: m.user.username, guildId: guild.id, guildName: guild.name, msgCount: 0, cmdCount: 0, lastSeen: null });
      }
    }
    const seen = new Set<string>();
    res.json(members.filter(m => { if (seen.has(m.userId)) return false; seen.add(m.userId); return true; }).slice(0, 200));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
