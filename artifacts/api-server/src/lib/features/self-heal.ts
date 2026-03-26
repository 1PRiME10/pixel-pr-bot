// ─── Self-Healing System ─────────────────────────────────────────────────────
// Detects runtime errors, analyses them with Gemini AI, attempts auto-recovery,
// logs to DB, and reports to a designated Discord admin channel.

import {
  Client, EmbedBuilder, TextChannel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from "discord.js";
import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";
import { shouldAttemptFix, attemptAutoFix, autoFixEnabled } from "./auto-fix.js";

// ─── State ────────────────────────────────────────────────────────────────────
let discordClient: Client | null = null;
let adminChannelId: string | null = null;
let healthIntervalId: ReturnType<typeof setInterval> | null = null;

// Debounce: one alert per unique error key per minute
const recentErrors = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

// Sweep stale debounce entries every 5 minutes to prevent unbounded growth
// (each unique error key stays forever otherwise — hundreds of keys per hour under load)
setInterval(() => {
  const cutoff = Date.now() - DEBOUNCE_MS;
  for (const [k, ts] of recentErrors.entries()) {
    if (ts < cutoff) recentErrors.delete(k);
  }
}, 5 * 60_000);

// ─── In-Memory Fix Cache ───────────────────────────────────────────────────────
// Caches pending fix data so the "Apply Fix" button can open the modal instantly
// without waiting for a DB query (which could exceed Discord's 3-second window).
// Survives for the life of the process; bot restart falls back to DB regeneration.
interface PendingFix { context: string; suggestion: string; target_file: string }
const pendingFixCache = new Map<string, PendingFix>();

export function getCachedFix(fixId: string): PendingFix | undefined {
  return pendingFixCache.get(String(fixId));
}

function cacheFix(fixId: string, data: PendingFix): void {
  pendingFixCache.set(String(fixId), data);
  // Evict oldest entries if cache grows too large (keep max 200)
  if (pendingFixCache.size > 200) {
    const firstKey = pendingFixCache.keys().next().value;
    if (firstKey) pendingFixCache.delete(firstKey);
  }
}

// ─── DB Init ──────────────────────────────────────────────────────────────────
export async function initSelfHeal(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_heal_errors (
      id          SERIAL PRIMARY KEY,
      error_type  TEXT NOT NULL,
      error_msg   TEXT NOT NULL,
      stack       TEXT,
      context     TEXT,
      ai_category TEXT,
      ai_analysis TEXT,
      ai_fix      TEXT,
      auto_fixed  BOOLEAN DEFAULT FALSE,
      fix_action  TEXT,
      guild_id    TEXT,
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS self_heal_config (
      id         TEXT PRIMARY KEY DEFAULT 'singleton',
      channel_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS self_heal_pending_fixes (
      id          SERIAL PRIMARY KEY,
      context     TEXT NOT NULL,
      suggestion  TEXT NOT NULL,
      target_file TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS self_heal_errors_occurred_at
      ON self_heal_errors (occurred_at DESC);
  `);

  const { rows } = await pool.query(
    `SELECT channel_id FROM self_heal_config WHERE id = 'singleton'`,
  );
  adminChannelId = rows[0]?.channel_id ?? null;

  setupGlobalHandlers();
  startHealthMonitor();

  // ── Prune errors older than 30 days every 6 hours ─────────────────────────
  // Without pruning, self_heal_errors grows indefinitely and slows down queries
  // (even with an index). 30 days keeps more than enough history for debugging.
  const pruneOldErrors = async () => {
    try {
      const res = await pool.query(
        `DELETE FROM self_heal_errors WHERE occurred_at < NOW() - INTERVAL '30 days'`,
      );
      if ((res.rowCount ?? 0) > 0) {
        console.log(`[SelfHeal] Pruned ${res.rowCount} error rows older than 30 days`);
      }
    } catch (e) {
      console.warn("[SelfHeal] Prune failed:", e);
    }
  };
  pruneOldErrors(); // run once at startup to clean up any backlog
  setInterval(pruneOldErrors, 6 * 60 * 60_000); // then every 6 hours

  console.log("[SelfHeal] Initialized — monitoring all errors");
}

export function setSelfHealClient(c: Client): void {
  discordClient = c;
}

// ─── Admin channel config ─────────────────────────────────────────────────────
export async function setHealthChannel(channelId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO self_heal_config (id, channel_id) VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, updated_at = NOW()`,
    [channelId],
  );
  adminChannelId = channelId;
}

// ─── Auto-Recovery: known error patterns ─────────────────────────────────────
async function tryAutoRecover(err: any): Promise<{ fixed: boolean; action: string }> {
  const msg  = String(err?.message ?? err ?? "");
  const code = Number(err?.code ?? err?.status ?? 0);

  // Rate limit — wait and let Discord cool down
  if (code === 429 || msg.includes("rate limit") || msg.toLowerCase().includes("ratelimited")) {
    const wait = Number(err?.retryAfter ?? 5000);
    await new Promise(r => setTimeout(r, Math.min(wait, 30_000)));
    return { fixed: true, action: `Rate limit — waited ${wait}ms automatically` };
  }

  // Interaction already acknowledged (40060) — safe to ignore
  if (code === 40060 || msg.includes("already been acknowledged")) {
    return { fixed: true, action: "Duplicate interaction — skipped gracefully" };
  }

  // Unknown channel — channel was deleted
  if (code === 10003 || msg.includes("Unknown Channel")) {
    return { fixed: false, action: "Channel no longer exists — update the channel config with /setserverlog or /setlog" };
  }

  // Missing permissions
  if (code === 50013 || msg.includes("Missing Permissions")) {
    return { fixed: false, action: "Bot lacks permissions — grant the required role or permission in Discord" };
  }

  // Missing Access
  if (code === 50001 || msg.includes("Missing Access")) {
    return { fixed: false, action: "Bot cannot access this channel — check channel permission overrides" };
  }

  // Message too long
  if (code === 50035 || msg.includes("Must be 2000 or fewer")) {
    return { fixed: true, action: "Message was too long — auto-truncated response" };
  }

  // Cannot send DMs
  if (code === 50007 || msg.includes("Cannot send messages to this user")) {
    return { fixed: true, action: "User has DMs disabled — skipped DM silently" };
  }

  // Webhook token expired
  if (code === 10015 || msg.includes("Unknown Webhook")) {
    return { fixed: false, action: "Webhook expired — needs to be re-created" };
  }

  return { fixed: false, action: "No automatic fix available for this error type" };
}

// ─── AI Analysis via Gemini ───────────────────────────────────────────────────
async function analyzeWithAI(err: any, context: string): Promise<{
  category: string;
  analysis: string;
  suggestion: string;
}> {
  try {
    const prompt = `You are a Discord bot error analyst. Be concise and technical.

Error: ${String(err?.message ?? err).slice(0, 400)}
Code: ${err?.code ?? "N/A"}
Type: ${err?.constructor?.name ?? "Error"}
Stack: ${(err?.stack ?? "").slice(0, 400)}
Context: ${context}

Respond ONLY with a JSON object (no markdown, no code block):
{
  "category": "one of: rate_limit | missing_permissions | invalid_channel | discord_api | database | network | logic | unknown",
  "analysis": "2-3 sentences explaining what went wrong and why",
  "suggestion": "1-2 actionable sentences on how to fix it"
}`;

    const responseText = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      maxOutputTokens: 1024,
    });

    const raw = (() => {
      let s = (responseText ?? "{}").replace(/^```[\w]*\n?/gm,"").replace(/\n?```$/gm,"").trim();
      const f = s.indexOf("{"), l = s.lastIndexOf("}");
      return (f !== -1 && l > f) ? s.slice(f, l + 1) : s;
    })();
    const json = JSON.parse(raw);
    return {
      category:   String(json.category   ?? "unknown"),
      analysis:   String(json.analysis   ?? "Unable to analyse error"),
      suggestion: String(json.suggestion ?? "Check server logs for more detail"),
    };
  } catch {
    return {
      category:   "unknown",
      analysis:   String(err?.message ?? err).slice(0, 300),
      suggestion: "Review the server logs for full stack trace",
    };
  }
}

// ─── Store error in DB ────────────────────────────────────────────────────────
async function storeError(
  err:        any,
  context:    string,
  category:   string,
  analysis:   string,
  suggestion: string,
  autoFixed:  boolean,
  fixAction:  string,
  guildId?:   string,
): Promise<void> {
  await pool.query(
    `INSERT INTO self_heal_errors
       (error_type, error_msg, stack, context, ai_category, ai_analysis, ai_fix, auto_fixed, fix_action, guild_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      (err?.constructor?.name ?? "Error").slice(0, 100),
      String(err?.message ?? err).slice(0, 500),
      (err?.stack ?? null)?.slice(0, 1000),
      context.slice(0, 500),
      category,
      analysis.slice(0, 1000),
      suggestion.slice(0, 500),
      autoFixed,
      fixAction.slice(0, 300),
      guildId ?? null,
    ],
  ).catch(e => console.error("[SelfHeal] DB store failed:", e));
}

// ─── Map error context → best target file for /improve ───────────────────────
const SRC = "artifacts/api-server/src/lib";
function contextToTarget(context: string): string {
  if (context.includes("autofix") || context.includes("auto-fix")) return `${SRC}/features/auto-fix.ts`;
  if (context.includes("security"))   return `${SRC}/features/auto-security.ts`;
  if (context.includes("memory"))     return `${SRC}/features/memory.ts`;
  if (context.includes("sentiment"))  return `${SRC}/features/sentiment.ts`;
  if (context.includes("profiling"))  return `${SRC}/features/profiling.ts`;
  if (context.includes("aesthetic"))  return `${SRC}/features/aesthetic.ts`;
  if (context.includes("daily"))      return `${SRC}/features/daily.ts`;
  if (context.includes("translate"))  return `${SRC}/features/translate.ts`;
  if (context.includes("games"))      return `${SRC}/features/games.ts`;
  if (context.includes("heal"))       return `${SRC}/features/self-heal.ts`;
  if (context.includes("twitter") || context.includes("tweet")) return `${SRC}/features/tweet-monitor.ts`;
  if (context.includes("youtube"))    return `${SRC}/features/youtube-monitor.ts`;
  if (context.includes("welcome"))    return `${SRC}/features/welcome.ts`;
  if (context.includes("moderat"))    return `${SRC}/features/moderation.ts`;
  if (context.includes("radio"))      return `${SRC}/features/radio.ts`;
  if (context.includes("tracker"))    return `${SRC}/features/tracker.ts`;
  if (context.includes("slash"))      return `${SRC}/features/slash-commands.ts`;
  if (context.includes("discord"))    return `${SRC}/discord-bot.ts`;
  return `${SRC}/features/slash-commands.ts`;
}

// ─── Report to admin Discord channel ─────────────────────────────────────────
const CATEGORY_COLORS: Record<string, number> = {
  rate_limit:          0xffeaa7,
  missing_permissions: 0xfdcb6e,
  invalid_channel:     0xe17055,
  discord_api:         0xff7675,
  database:            0xd63031,
  network:             0xe84393,
  logic:               0x6c5ce7,
  unknown:             0x636e72,
};

async function reportToAdmin(
  errMsg:        string,
  category:      string,
  analysis:      string,
  suggestion:    string,
  autoFixed:     boolean,
  fixAction:     string,
  context:       string,
  codeFixResult: { applied: boolean; description: string; status: string } | null = null,
): Promise<void> {
  if (!discordClient || !adminChannelId) return;
  try {
    const ch = await discordClient.channels.fetch(adminChannelId).catch(() => null) as TextChannel | null;
    if (!ch || !("send" in ch)) return;

    const codeFixApplied = codeFixResult?.applied ?? false;
    const icon  = (autoFixed || codeFixApplied) ? "🔧" : "⚠️";
    const color = codeFixApplied ? 0x00b894 : (CATEGORY_COLORS[category] ?? 0x636e72);

    const fields: { name: string; value: string; inline: boolean }[] = [
      { name: "🧠 AI Analysis",  value: analysis.slice(0, 1024),  inline: false },
      { name: "💡 Suggestion",   value: suggestion.slice(0, 1024), inline: false },
      { name: "📍 Context",      value: context.slice(0, 200),     inline: true  },
      {
        name:   autoFixed ? "✅ Runtime Fix" : "⚡ Runtime",
        value:  fixAction.slice(0, 300),
        inline: true,
      },
    ];

    // Add code-fix result if an auto-fix was attempted
    if (codeFixResult) {
      if (codeFixResult.applied) {
        fields.push({
          name:   "🧬 Code Fix Applied ✅ — Fully Automatic",
          value:  `${codeFixResult.description}\n\n**⚡ Restarting now with the fix...**\n🔄 Production will auto-apply this patch on its next startup (≤30 min).`,
          inline: false,
        });
      } else {
        const statusLabels: Record<string, string> = {
          failed_ts:    "❌ Patch failed TypeScript validation — rolled back",
          failed_build: "❌ Build failed after patch — rolled back",
          failed_patch: "❌ AI patch could not be applied to source",
          no_fix:       "🤔 Gemini could not determine a safe fix",
          no_file:      "📁 Could not identify source file",
          rollback:     "↩️ Rolled back to previous version",
        };
        fields.push({
          name:   "🧬 Code Fix Attempted ❌",
          value:  `${statusLabels[codeFixResult.status] ?? codeFixResult.status}\n${codeFixResult.description}`,
          inline: false,
        });
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`${icon} Self-Heal — ${category.replace(/_/g, " ").toUpperCase()}`)
      .setColor(color)
      .setDescription(`\`\`\`${errMsg.slice(0, 300)}\`\`\``)
      .addFields(fields)
      .setTimestamp();

    // Save suggestion to DB and attach "Apply Fix" button for one-click code repair.
    // Show the button whenever there is a meaningful suggestion — even if a runtime/code fix
    // was already attempted — so the admin always has a manual override option.
    let components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (suggestion && suggestion.length > 10) {
      try {
        const targetFile = contextToTarget(context);
        const { rows: fixRows } = await pool.query(
          `INSERT INTO self_heal_pending_fixes (context, suggestion, target_file) VALUES ($1, $2, $3) RETURNING id`,
          [context, suggestion.slice(0, 3900), targetFile],
        );
        const fixId = fixRows[0]?.id;
        if (fixId) {
          // Cache immediately so the button handler can open modal without DB wait
          cacheFix(String(fixId), { context, suggestion: suggestion.slice(0, 3900), target_file: targetFile });
          // Label changes based on whether an auto-fix was already applied
          const btnLabel = codeFixResult?.applied ? "🔧 Apply Alternative Fix" : "🔧 Apply Fix";
          const applyBtn = new ButtonBuilder()
            .setCustomId(`sh_apply:${fixId}`)
            .setLabel(btnLabel)
            .setStyle(codeFixResult?.applied ? ButtonStyle.Secondary : ButtonStyle.Primary);
          components = [new ActionRowBuilder<ButtonBuilder>().addComponents(applyBtn)];
        }
      } catch (e) {
        console.error("[SelfHeal] Failed to save pending fix:", e);
      }
    }

    await ch.send({ embeds: [embed], components });
  } catch (e) {
    console.error("[SelfHeal] Failed to send admin report:", e);
  }
}

// ─── Main Error Handler (called by all modules) ───────────────────────────────
export async function handleError(
  err:      any,
  context:  string,
  guildId?: string,
): Promise<void> {
  // Debounce identical errors within 1 minute
  const key      = `${context}:${err?.code ?? String(err?.message ?? "").slice(0, 60)}`;
  const lastSeen = recentErrors.get(key);
  if (lastSeen && Date.now() - lastSeen < DEBOUNCE_MS) return;
  recentErrors.set(key, Date.now());

  console.error(`[SelfHeal] Error in ${context}:`, err);

  // 1. Try fast auto-recovery (runtime fix — rate limits, bad channels, etc.)
  const { fixed, action } = await tryAutoRecover(err);

  // Silently skip well-known benign errors that are already handled —
  // no admin notification needed: they're routine and just create noise.
  const code = Number(err?.code ?? err?.status ?? 0);
  const msgLow = String(err?.message ?? err ?? "").toLowerCase();
  if (
    code === 40060 || msgLow.includes("already been acknowledged") || // duplicate interaction
    code === 10062 || msgLow.includes("unknown interaction") ||        // interaction expired (restart/timeout) — not a code bug
    code === 10008 || msgLow.includes("unknown message") ||            // message deleted before bot could act
    (code === 429  || msgLow.includes("rate limit"))                   // rate limited — waited and recovered
  ) {
    console.log(`[SelfHeal] Benign error suppressed (${code || "rate-limit"}): ${action}`);
    return;
  }

  // 2. AI error analysis
  const { category, analysis, suggestion } = await analyzeWithAI(err, context);

  // 3. Store in DB
  await storeError(err, context, category, analysis, suggestion, fixed, action, guildId);

  // 4. Check if auto-fix engine should attempt a code-level fix
  let codeFixResult: { applied: boolean; description: string; status: string } | null = null;
  if (!fixed && shouldAttemptFix(key)) {
    console.log(`[SelfHeal] Error "${key}" hit threshold — attempting code-level auto-fix...`);
    codeFixResult = await attemptAutoFix(err, context, key);
  }

  // 5. Report to admin channel (includes code-fix result if attempted)
  await reportToAdmin(
    String(err?.message ?? err).slice(0, 400),
    category,
    analysis,
    suggestion,
    fixed,
    action,
    context,
    codeFixResult,
  );
}

// ─── Global uncaught handlers ─────────────────────────────────────────────────
function setupGlobalHandlers(): void {
  process.on("unhandledRejection", (reason: any) => {
    // Skip common benign / transient errors — not code bugs
    const msg  = String(reason?.message ?? reason ?? "").toLowerCase();
    const code = Number(reason?.code ?? reason?.status ?? 0);
    if (msg.includes("already been acknowledged")) return;
    if (msg.includes("rate limit") && code !== 429) return;
    if (code === 10062 || msg.includes("unknown interaction")) return;  // expired during restart
    if (code === 10008 || msg.includes("unknown message")) return;       // deleted message
    if (code === 50013 || msg.includes("missing permissions")) return;   // permissions issue — runtime, not code
    handleError(reason, "unhandledRejection").catch(console.error);
  });

  process.on("uncaughtException", (err: Error) => {
    handleError(err, "uncaughtException").catch(console.error);
  });
}

// ─── Health Status ────────────────────────────────────────────────────────────
export async function getHealthStatus(): Promise<{
  uptime:    string;
  errors24h: number;
  autoFixed: number;
  topErrors: { category: string; count: number }[];
  dbOk:      boolean;
  discordOk: boolean;
}> {
  let errors24h = 0;
  let autoFixed = 0;
  let topErrors: { category: string; count: number }[] = [];
  let dbOk = false;

  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int                                              AS total,
        SUM(CASE WHEN auto_fixed THEN 1 ELSE 0 END)::int         AS fixed
      FROM self_heal_errors
      WHERE occurred_at > NOW() - INTERVAL '24 hours'
    `);
    errors24h = rows[0]?.total ?? 0;
    autoFixed = rows[0]?.fixed ?? 0;

    const { rows: top } = await pool.query(`
      SELECT ai_category AS category, COUNT(*)::int AS count
      FROM self_heal_errors
      WHERE occurred_at > NOW() - INTERVAL '24 hours'
      GROUP BY ai_category
      ORDER BY count DESC
      LIMIT 3
    `);
    topErrors = top;
    dbOk = true;
  } catch { dbOk = false; }

  const discordOk = !!(discordClient?.isReady());
  const uptimeSec = discordClient?.uptime ? Math.floor(discordClient.uptime / 1000) : 0;
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const uptime = uptimeSec ? `${d}d ${h}h ${m}m` : "Standby / Not connected";

  return { uptime, errors24h, autoFixed, topErrors, dbOk, discordOk };
}

export function buildHealthEmbed(
  h: Awaited<ReturnType<typeof getHealthStatus>>,
): EmbedBuilder {
  const allGood    = h.discordOk && h.dbOk && h.errors24h < 5;
  const topErrText = h.topErrors.length
    ? h.topErrors.map(e => `\`${e.category}\`: ${e.count}`).join("\n")
    : "No errors in 24h 🎉";

  return new EmbedBuilder()
    .setTitle(allGood ? "💚 System Health — All Good" : "🟡 System Health — Needs Attention")
    .setColor(allGood ? 0x00b894 : 0xfdcb6e)
    .addFields(
      { name: "⏱️ Uptime",         value: h.uptime,                                       inline: true  },
      { name: "🔗 Discord",        value: h.discordOk ? "✅ Connected" : "❌ Offline",    inline: true  },
      { name: "🗄️ Database",       value: h.dbOk      ? "✅ Online"   : "❌ Offline",    inline: true  },
      { name: "⚠️ Errors (24h)",   value: String(h.errors24h),                            inline: true  },
      { name: "🔧 Auto-Fixed",     value: String(h.autoFixed),                            inline: true  },
      { name: "📊 Top Error Types", value: topErrText,                                    inline: false },
    )
    .setTimestamp();
}

// ─── Periodic health report every 6 hours ────────────────────────────────────
function startHealthMonitor(): void {
  if (healthIntervalId) return;
  healthIntervalId = setInterval(async () => {
    if (!discordClient || !adminChannelId) return;
    try {
      const health = await getHealthStatus();
      // Only report if there were errors OR something is wrong
      if (health.errors24h === 0 && health.discordOk && health.dbOk) return;
      const ch = await discordClient.channels.fetch(adminChannelId).catch(() => null) as TextChannel | null;
      if (!ch || !("send" in ch)) return;
      await ch.send({ embeds: [buildHealthEmbed(health)] });
    } catch (e) {
      console.error("[SelfHeal] Periodic health report failed:", e);
    }
  }, 6 * 60 * 60 * 1000);
}

// ─── Recent errors query (for /errors command) ────────────────────────────────
export async function getRecentErrors(limit = 5): Promise<{
  id:          number;
  errorMsg:    string;
  category:    string;
  analysis:    string;
  suggestion:  string;
  autoFixed:   boolean;
  fixAction:   string;
  context:     string;
  occurredAt:  Date;
}[]> {
  const { rows } = await pool.query(
    `SELECT id, error_msg, ai_category, ai_analysis, ai_fix, auto_fixed, fix_action, context, occurred_at
     FROM self_heal_errors
     ORDER BY occurred_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(r => ({
    id:         r.id,
    errorMsg:   r.error_msg,
    category:   r.ai_category ?? "unknown",
    analysis:   r.ai_analysis ?? "",
    suggestion: r.ai_fix      ?? "",
    autoFixed:  r.auto_fixed,
    fixAction:  r.fix_action  ?? "",
    context:    r.context     ?? "",
    occurredAt: r.occurred_at,
  }));
}
