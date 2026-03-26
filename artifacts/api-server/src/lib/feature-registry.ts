// ─── Feature Registry ─────────────────────────────────────────────────────────
// Single source of truth for every feature the bot exposes.
// Each entry describes the feature and whether it is enabled.
//
// Security model
//   • Only users listed in the PIXEL_OWNER_IDS environment variable can use
//     !feature commands (independent of Discord server-admin permissions).
//   • Feature state is persisted in the database so toggling survives restarts.
//   • Features marked `essential: true` cannot be disabled — they are core to
//     the bot's operation and safety.
//
// Usage (discord-bot.ts)
//   await initFeatureRegistry();
//   if (isFeatureEnabled("tracker")) { ... }
//   await setFeatureEnabled("tracker", false);
//
// Usage (feature files — listener-based guard)
//   import { isFeatureEnabled } from "../feature-registry.js";
//   client.on("messageCreate", async (message) => {
//     if (!isFeatureEnabled("translate")) return;
//     ...
//   });

import { pool } from "@workspace/db";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface FeatureDef {
  key: string;
  name: string;
  nameAr: string;
  description: string;
  category: "ai" | "moderation" | "security" | "utility" | "social" | "media" | "tracking" | "core";
  defaultEnabled: boolean;
  essential: boolean;
}

// ─── Master feature array ─────────────────────────────────────────────────────
export const FEATURE_REGISTRY: readonly FeatureDef[] = [
  // ── Core (always-on, cannot be disabled) ────────────────────────────────────
  {
    key: "consent",
    name: "Privacy Consent",
    nameAr: "موافقة الخصوصية",
    description: "GDPR-style privacy notice and consent management",
    category: "core",
    defaultEnabled: true,
    essential: true,
  },
  {
    key: "dedup",
    name: "Message Deduplication",
    nameAr: "منع تكرار الردود",
    description: "DB-backed dedup preventing double-responses across instances",
    category: "core",
    defaultEnabled: true,
    essential: true,
  },
  {
    key: "auto_security",
    name: "Auto-Security",
    nameAr: "الأمان التلقائي",
    description: "New-account kick, invite/phishing/spam detection, raid lockdown",
    category: "security",
    defaultEnabled: true,
    essential: true,
  },

  // ── AI ───────────────────────────────────────────────────────────────────────
  {
    key: "ai_chat",
    name: "AI Chat (PIXEL)",
    nameAr: "الدردشة الذكية (PIXEL)",
    description: "Gemini-powered conversation with vision and long-term memory",
    category: "ai",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "imagine",
    name: "Image Generation",
    nameAr: "توليد الصور",
    description: "!imagine — AI-generated images from text prompts",
    category: "ai",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "search_summary",
    name: "Search & Summary",
    nameAr: "البحث والتلخيص",
    description: "!search / !summary — AI topic summaries and channel briefings",
    category: "ai",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "persona",
    name: "Roleplay Persona",
    nameAr: "شخصية الأدوار",
    description: "!persona — custom AI persona for roleplay channels",
    category: "ai",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "sentiment",
    name: "Sentiment Radar",
    nameAr: "رادار المشاعر",
    description: "Daily AI server mood report (Arabic) + !briefing command",
    category: "ai",
    defaultEnabled: true,
    essential: false,
  },

  // ── Tracking ─────────────────────────────────────────────────────────────────
  {
    key: "tracker",
    name: "Anime / Manga Tracker",
    nameAr: "متتبع الأنمي والمانغا",
    description: "!track — AniList episode alerts + MangaDex chapter alerts",
    category: "tracking",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "jp_tracker",
    name: "JP Event Live Tracker",
    nameAr: "متتبع الفعاليات اليابانية",
    description: "Live countdown for Japanese idol / music events",
    category: "tracking",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "tweet_monitor",
    name: "Twitter / X Monitor",
    nameAr: "مراقب تويتر/X",
    description: "!addtwitter — repost tweets from monitored accounts",
    category: "tracking",
    defaultEnabled: true,
    essential: false,
  },

  // ── Moderation ───────────────────────────────────────────────────────────────
  {
    key: "moderation",
    name: "Moderation Tools",
    nameAr: "أدوات الإشراف",
    description: "!kick, !ban, !mute, !warn, !clear and more",
    category: "moderation",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "profanity_filter",
    name: "Profanity Filter",
    nameAr: "فلتر الألفاظ",
    description: "Auto-delete custom bad words with 3-strike system",
    category: "moderation",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "server_log",
    name: "Server Log",
    nameAr: "سجل الخادم",
    description: "!setserverlog — log joins, leaves, bans and message deletes",
    category: "moderation",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "profiling",
    name: "Behavioral Profiling",
    nameAr: "تحليل السلوك",
    description: "!profile / !myprofile — AI-generated activity reports",
    category: "moderation",
    defaultEnabled: true,
    essential: false,
  },

  // ── Social ───────────────────────────────────────────────────────────────────
  {
    key: "reputation",
    name: "Reputation System",
    nameAr: "نظام السمعة",
    description: "+rep @user — reputation points with daily cooldown and leaderboard",
    category: "social",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "games",
    name: "Mini Games",
    nameAr: "الألعاب الصغيرة",
    description: "!wyr, !wordchain — Would You Rather and Word Chain",
    category: "social",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "welcome",
    name: "Welcome System",
    nameAr: "نظام الترحيب",
    description: "!setwelcome — custom welcome messages for new members",
    category: "social",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "teto_emojis",
    name: "Ai Hoshino Emojis",
    nameAr: "إيموجيات آي هوشينو",
    description: "Auto-upload Ai Hoshino expression emojis to every joined server",
    category: "social",
    defaultEnabled: true,
    essential: false,
  },

  // ── Utility ──────────────────────────────────────────────────────────────────
  {
    key: "translate",
    name: "Auto-Translate",
    nameAr: "الترجمة التلقائية",
    description: "React with a flag emoji to translate any message",
    category: "utility",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "aesthetic",
    name: "Aesthetic Text",
    nameAr: "النص الجمالي",
    description: "!aesthetic — Japanese translation + decorative font variants",
    category: "utility",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "steganography",
    name: "Steganography",
    nameAr: "إخفاء الرسائل",
    description: "!hide / !reveal — hide secret messages inside PNG images",
    category: "utility",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "radio",
    name: "Radio Player",
    nameAr: "مشغل الراديو",
    description: "!setradio — 24/7 internet radio in voice channels",
    category: "media",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "daily",
    name: "Daily Inspiration",
    nameAr: "الإلهام اليومي",
    description: "Auto-send a motivational message every morning at 8:00 AM UTC",
    category: "utility",
    defaultEnabled: true,
    essential: false,
  },
  {
    key: "chat_mode",
    name: "Chat Mode",
    nameAr: "وضع الدردشة",
    description: "!chat on/off — auto-respond to every message in a channel",
    category: "utility",
    defaultEnabled: true,
    essential: false,
  },
] as const;

// ─── State cache (loaded from DB at startup) ──────────────────────────────────
// Populated by initFeatureRegistry(). Fast synchronous lookups at runtime.
const _stateCache = new Map<string, boolean>();
let _initialized = false;

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initFeatureRegistry(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_states (
      key        TEXT PRIMARY KEY,
      enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);

  // Seed any new features that aren't in the DB yet
  for (const f of FEATURE_REGISTRY) {
    await pool.query(
      `INSERT INTO feature_states (key, enabled) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [f.key, f.defaultEnabled],
    );
  }

  // Load all states into memory cache
  const { rows } = await pool.query<{ key: string; enabled: boolean }>(
    `SELECT key, enabled FROM feature_states`,
  );
  _stateCache.clear();
  for (const row of rows) {
    _stateCache.set(row.key, row.enabled);
  }

  // Fill in any features not yet in DB (defensive)
  for (const f of FEATURE_REGISTRY) {
    if (!_stateCache.has(f.key)) {
      _stateCache.set(f.key, f.defaultEnabled);
    }
  }

  _initialized = true;
}

// ─── Runtime accessors ────────────────────────────────────────────────────────

/**
 * Fast synchronous check — call this at the top of every feature handler.
 * Essential features always return true regardless of DB state.
 */
export function isFeatureEnabled(key: string): boolean {
  if (!_initialized) return true; // safe default before init completes
  const def = FEATURE_REGISTRY.find(f => f.key === key);
  if (def?.essential) return true; // can never be disabled
  return _stateCache.get(key) ?? true;
}

/**
 * Persist a new enabled/disabled state to the DB and update the in-memory cache.
 * `updatedBy` is the Discord user ID performing the change (for audit trail).
 */
export async function setFeatureEnabled(
  key: string,
  enabled: boolean,
  updatedBy?: string,
): Promise<boolean> {
  const def = FEATURE_REGISTRY.find(f => f.key === key);
  if (!def) return false; // unknown key
  if (def.essential && !enabled) return false; // cannot disable essential features

  await pool.query(
    `INSERT INTO feature_states (key, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled,
                                     updated_by = EXCLUDED.updated_by,
                                     updated_at = NOW()`,
    [key, enabled, updatedBy ?? null],
  );
  _stateCache.set(key, enabled);
  return true;
}

// ─── Owner guard ──────────────────────────────────────────────────────────────
/**
 * Returns true only if `userId` is listed in the PIXEL_OWNER_IDS env variable.
 * Format: comma-separated Discord user IDs, e.g.  "123456789,987654321"
 * If PIXEL_OWNER_IDS is not set, NO ONE can use owner-only commands (secure default).
 */
export function isBotOwner(userId: string): boolean {
  const raw = process.env.PIXEL_OWNER_IDS ?? "";
  if (!raw.trim()) return false;
  return raw.split(",").map(s => s.trim()).includes(userId);
}

// ─── Discord command handler (!feature ...) ───────────────────────────────────
// Called from discord-bot.ts main handler. Returns true if the message was handled.
export async function handleFeatureCommand(
  message: { reply: (t: any) => Promise<any>; author: { id: string }; channel: any },
  args: string[],
): Promise<boolean> {
  const sub = args[0]?.toLowerCase();

  // Only bot owners can use this command
  if (!isBotOwner(message.author.id)) {
    await message.reply(
      "🔒 **Access denied.** Only bot owners can manage features.\n" +
      "Ask the bot owner to add your Discord ID to `PIXEL_OWNER_IDS`."
    );
    return true;
  }

  // !feature list
  if (!sub || sub === "list") {
    const categories = [...new Set(FEATURE_REGISTRY.map(f => f.category))];
    const lines: string[] = ["📋 **Feature Registry** — all bot features\n"];

    for (const cat of categories) {
      const catFeatures = FEATURE_REGISTRY.filter(f => f.category === cat);
      lines.push(`__${cat.toUpperCase()}__`);
      for (const f of catFeatures) {
        const enabled = isFeatureEnabled(f.key);
        const icon = f.essential ? "🔒" : enabled ? "✅" : "❌";
        const lock = f.essential ? " *(essential)*" : "";
        lines.push(`${icon} \`${f.key}\` — ${f.nameAr}${lock}`);
      }
      lines.push("");
    }

    lines.push("Use `!feature enable <key>` or `!feature disable <key>` to toggle.");

    const text = lines.join("\n");
    if (text.length <= 2000) {
      await message.reply(text);
    } else {
      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        if ((current + "\n" + line).length > 1900) {
          chunks.push(current);
          current = line;
        } else {
          current = current ? current + "\n" + line : line;
        }
      }
      if (current) chunks.push(current);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) await message.reply(chunks[i]);
        else await (message.channel as any).send(chunks[i]);
      }
    }
    return true;
  }

  // !feature enable <key> | !feature disable <key>
  if (sub === "enable" || sub === "disable") {
    const key = args[1]?.toLowerCase();
    if (!key) {
      await message.reply(`**Usage:** \`!feature ${sub} <key>\`\nSee \`!feature list\` for available keys.`);
      return true;
    }

    const def = FEATURE_REGISTRY.find(f => f.key === key);
    if (!def) {
      await message.reply(`❌ Unknown feature key \`${key}\`. Use \`!feature list\` to see valid keys.`);
      return true;
    }

    if (def.essential && sub === "disable") {
      await message.reply(`🔒 **${def.name}** is an essential feature and cannot be disabled.`);
      return true;
    }

    const wantEnabled = sub === "enable";
    const changed = await setFeatureEnabled(key, wantEnabled, message.author.id);
    if (!changed) {
      await message.reply(`❌ Failed to update feature state. Check server logs.`);
      return true;
    }

    const icon = wantEnabled ? "✅" : "❌";
    await message.reply(
      `${icon} **${def.name}** (\`${key}\`) has been **${wantEnabled ? "enabled" : "disabled"}**.\n` +
      (wantEnabled
        ? "The feature is now active."
        : "The feature will no longer respond to commands or events. Listener-based features take full effect after a bot restart.")
    );
    return true;
  }

  // !feature info <key>
  if (sub === "info") {
    const key = args[1]?.toLowerCase();
    if (!key) {
      await message.reply("**Usage:** `!feature info <key>`");
      return true;
    }
    const def = FEATURE_REGISTRY.find(f => f.key === key);
    if (!def) {
      await message.reply(`❌ Unknown feature key \`${key}\`.`);
      return true;
    }
    const enabled = isFeatureEnabled(key);
    await message.reply([
      `**${def.name}** (\`${def.key}\`)`,
      `🔤 Arabic name: ${def.nameAr}`,
      `📁 Category: ${def.category}`,
      `📝 ${def.description}`,
      `${enabled ? "✅" : "❌"} Status: ${enabled ? "Enabled" : "Disabled"}`,
      def.essential ? "🔒 Essential — cannot be disabled" : "",
    ].filter(Boolean).join("\n"));
    return true;
  }

  await message.reply(
    "**!feature commands:**\n" +
    "`!feature list` — show all features and their status\n" +
    "`!feature enable <key>` — enable a feature\n" +
    "`!feature disable <key>` — disable a feature\n" +
    "`!feature info <key>` — show feature details"
  );
  return true;
}
