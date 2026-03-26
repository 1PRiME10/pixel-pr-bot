import { isClaimed } from "../message-gate.js";
// ─── Behavioural Profiling System ─────────────────────────────────────────────
// Tracks ONLY consented users. Analyses communication patterns to help admins
// understand server dynamics — not psychological diagnosis.
//
// What is tracked (per user, per guild):
//   • Message count and command usage
//   • Active hours (which hours of the day they post)
//   • Recurring keywords (topics they discuss most)
//   • First seen / last seen timestamps
//   • Starter vs responder ratio (do they open conversations or reply?)
//
// Security:
//   • Only consented users are tracked (checked via hasConsented())
//   • Only admins can request !profile reports
//   • Users can see their own stats via !myprofile
//   • !forget wipes the profile row entirely
//   • Full message content is NOT stored — only keyword frequencies

import { Client, Message, TextChannel, PermissionFlagsBits, ChannelType } from "discord.js";
import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

// ─── Self-contained consent check (independent from consent.ts) ───────────────
// Uses its own lightweight in-memory cache backed by the shared DB table.
const _profilingConsentCache = new Set<string>();
let _profilingConsentLoaded = false;

async function hasConsented(userId: string): Promise<boolean> {
  if (!_profilingConsentLoaded) {
    // Lazy-load once on first call
    const { rows } = await pool.query(`SELECT user_id FROM user_consent`).catch(() => ({ rows: [] as { user_id: string }[] }));
    for (const r of rows) _profilingConsentCache.add(r.user_id);
    _profilingConsentLoaded = true;
  }
  if (_profilingConsentCache.has(userId)) return true;
  // Re-check DB in case consent was given after the cache was loaded
  const { rows } = await pool.query(`SELECT 1 FROM user_consent WHERE user_id = $1`, [userId]).catch(() => ({ rows: [] }));
  if (rows.length > 0) { _profilingConsentCache.add(userId); return true; }
  return false;
}

// ── Profile-report log channel (per guild) ────────────────────────────────────
export const reportChannels = new Map<string, string>(); // guildId → channelId

async function loadReportChannels(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_report_channels (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  const { rows } = await pool.query(`SELECT guild_id, channel_id FROM profile_report_channels`);
  for (const r of rows) reportChannels.set(r.guild_id, r.channel_id);
}

export async function setReportChannel(guildId: string, channelId: string | null): Promise<void> {
  if (channelId) {
    reportChannels.set(guildId, channelId);
    await pool.query(
      `INSERT INTO profile_report_channels (guild_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
      [guildId, channelId],
    );
  } else {
    reportChannels.delete(guildId);
    await pool.query(`DELETE FROM profile_report_channels WHERE guild_id = $1`, [guildId]);
  }
}

// ── In-memory write buffer (flush every 5 min) ────────────────────────────────
interface PendingStats {
  msgDelta:     number;
  cmdDelta:     number;
  hourCounts:   number[];  // 24 slots
  keywords:     Map<string, number>;
  isStarter:    boolean;
  username:     string | null;
}
const pendingWrites = new Map<string, PendingStats>(); // key = `userId:guildId`

function getPending(userId: string, guildId: string, username?: string | null): PendingStats {
  const key = `${userId}:${guildId}`;
  if (!pendingWrites.has(key)) {
    pendingWrites.set(key, {
      msgDelta:   0,
      cmdDelta:   0,
      hourCounts: new Array(24).fill(0),
      keywords:   new Map(),
      isStarter:  false,
      username:   username ?? null,
    });
  } else if (username) {
    // Always keep the freshest username in case it changed
    pendingWrites.get(key)!.username = username;
  }
  return pendingWrites.get(key)!;
}

// ── DB init ──────────────────────────────────────────────────────────────────
export async function initProfiling(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id       TEXT    NOT NULL,
      guild_id      TEXT    NOT NULL,
      msg_count     INTEGER NOT NULL DEFAULT 0,
      cmd_count     INTEGER NOT NULL DEFAULT 0,
      hour_counts   INTEGER[] NOT NULL DEFAULT '{0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}',
      keywords      JSONB   NOT NULL DEFAULT '{}',
      first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      starter_msgs  INTEGER NOT NULL DEFAULT 0,
      responder_msgs INTEGER NOT NULL DEFAULT 0,
      username      TEXT,
      PRIMARY KEY (user_id, guild_id)
    )
  `);
  // Backfill: add column to existing deployments that lack it
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS username TEXT`);
  await loadReportChannels();
}

// ── Clear a user's profile (called from !forget) ─────────────────────────────
export async function clearProfile(userId: string, guildId: string): Promise<void> {
  pendingWrites.delete(`${userId}:${guildId}`);
  await pool.query(
    `DELETE FROM user_profiles WHERE user_id = $1 AND guild_id = $2`,
    [userId, guildId],
  );
}

// ── Record a message (fast, in-memory) ───────────────────────────────────────
export async function recordUserActivity(
  userId:    string,
  guildId:   string,
  content:   string,
  isCommand: boolean,
  isStarter: boolean,
  username?: string | null,
): Promise<void> {
  if (!(await hasConsented(userId))) return;

  const pending = getPending(userId, guildId, username);
  pending.msgDelta++;
  if (isCommand) pending.cmdDelta++;
  if (isStarter) pending.isStarter = true;

  const hour = new Date().getUTCHours();
  pending.hourCounts[hour]++;

  // Extract keywords (words >3 chars, skip common stop words)
  const stopWords = new Set([
    "that","this","with","have","from","they","will","would","could","should",
    "about","what","when","where","which","there","their","were","been","into",
    "your","just","like","more","also","than","then","some","very","over",
    "هذا","هذه","الذي","التي","على","في","من","إلى","مع","هو","هي","انا","انت",
    "كان","كانت","يكون","الان","بعد","قبل","لكن","هل","لما","ماذا",
  ]);

  for (const raw of content.toLowerCase().split(/\s+/)) {
    const word = raw.replace(/[^a-z0-9أ-يa-zA-Z]/gu, "");
    if (word.length > 3 && !stopWords.has(word) && !word.startsWith("!")) {
      pending.keywords.set(word, (pending.keywords.get(word) ?? 0) + 1);
    }
  }
}

// ── Flush pending writes to DB ────────────────────────────────────────────────
export async function flushPending(): Promise<void> {
  if (pendingWrites.size === 0) return;

  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();

  for (const [key, stats] of entries) {
    const [userId, guildId] = key.split(":");
    const kwObj: Record<string, number> = {};
    for (const [w, c] of stats.keywords) kwObj[w] = c;

    try {
      await pool.query(
        `INSERT INTO user_profiles
           (user_id, guild_id, msg_count, cmd_count, hour_counts, keywords,
            first_seen, last_seen, starter_msgs, responder_msgs, username)
         VALUES ($1, $2, $3, $4, $5::integer[], $6::jsonb, NOW(), NOW(), $7, $8, $9)
         ON CONFLICT (user_id, guild_id) DO UPDATE SET
           msg_count      = user_profiles.msg_count + EXCLUDED.msg_count,
           cmd_count      = user_profiles.cmd_count + EXCLUDED.cmd_count,
           hour_counts    = (
             SELECT array_agg(a + b ORDER BY idx)
             FROM unnest(user_profiles.hour_counts, EXCLUDED.hour_counts)
                  WITH ORDINALITY AS t(a, b, idx)
           ),
           keywords       = (
             SELECT jsonb_object_agg(key, COALESCE((user_profiles.keywords->>key)::int, 0) + value::int)
             FROM jsonb_each_text(EXCLUDED.keywords)
           ),
           last_seen      = NOW(),
           starter_msgs   = user_profiles.starter_msgs   + EXCLUDED.starter_msgs,
           responder_msgs = user_profiles.responder_msgs + EXCLUDED.responder_msgs,
           username       = COALESCE(EXCLUDED.username, user_profiles.username)`,
        [
          userId, guildId,
          stats.msgDelta,
          stats.cmdDelta,
          stats.hourCounts,
          JSON.stringify(kwObj),
          stats.isStarter ? 1 : 0,
          stats.isStarter ? 0 : 1,
          stats.username ?? null,
        ],
      );
    } catch (err) {
      console.error("[Profiling] flush error:", err);
    }
  }
}

// ── Load profile from DB ──────────────────────────────────────────────────────
export async function loadProfile(userId: string, guildId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM user_profiles WHERE user_id = $1 AND guild_id = $2`,
    [userId, guildId],
  );
  return rows[0] ?? null;
}

// ── Format active hours ───────────────────────────────────────────────────────
export function peakHours(hourCounts: number[]): string {
  const indexed = hourCounts.map((c, h) => ({ h, c })).sort((a, b) => b.c - a.c);
  const top = indexed.slice(0, 3).filter(x => x.c > 0);
  if (top.length === 0) return "Unknown";
  return top.map(x => {
    const period = x.h < 6 ? "🌙 Night" : x.h < 12 ? "🌅 Morning" : x.h < 18 ? "☀️ Afternoon" : "🌆 Evening";
    return `${period} (${x.h}:00 UTC)`;
  }).join(", ");
}

// ── Generate AI behavioural report ───────────────────────────────────────────
export async function generateProfileReport(
  row: Record<string, any>,
  targetTag: string,
): Promise<string> {
  const total   = row.msg_count as number;
  const cmds    = row.cmd_count as number;
  const starter = row.starter_msgs as number;
  const respond = row.responder_msgs as number;
  const hours   = row.hour_counts as number[];
  const kwRaw   = row.keywords as Record<string, number>;
  const topKw   = Object.entries(kwRaw)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
  const firstSeen = new Date(row.first_seen).toLocaleDateString("en-GB");
  const lastSeen  = new Date(row.last_seen).toLocaleDateString("en-GB");
  const starterRatio = (starter + respond) > 0
    ? Math.round((starter / (starter + respond)) * 100) : 0;

  const prompt =
    `You are a behavioural analyst for a Discord server. Based on the following data, write a short behavioural report (not a psychological diagnosis) in English.\n\n` +
    `User: ${targetTag}\n` +
    `Total messages: ${total}\n` +
    `Commands used: ${cmds}\n` +
    `First seen: ${firstSeen} | Last active: ${lastSeen}\n` +
    `Peak hours: ${peakHours(hours)}\n` +
    `Starts conversations: ${starterRatio}% of the time\n` +
    `Most frequent keywords: ${topKw.join(", ") || "insufficient data"}\n\n` +
    `Write a 5-7 sentence report covering:\n` +
    `1. General activity level (active / moderate / light)\n` +
    `2. Preferred active hours\n` +
    `3. Topics they discuss most\n` +
    `4. Do they lead conversations or participate in them?\n` +
    `5. A closing note useful for the server admin\n\n` +
    `Reminder: behavioural analysis only — no personal or psychological diagnoses. Use Discord markdown and emoji naturally.`;

  const text = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    maxOutputTokens: 1024,
  });

  return text?.trim() ?? "Failed to generate report.";
}

// ── Register ──────────────────────────────────────────────────────────────────
export function registerProfiling(client: Client, PREFIX: string): void {
  initProfiling().catch(console.error);

  // Flush pending writes every 5 minutes
  setInterval(() => flushPending().catch(console.error), 5 * 60_000);

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.guild) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    const content  = message.content.trim();
    const lower    = content.toLowerCase();
    const isAdmin  = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

    // ── Activity recording (consented users only) ─────────────────────────────
    if (await hasConsented(message.author.id)) {
      const isCommand = content.startsWith(PREFIX);
      const isStarter = !message.reference;
      await recordUserActivity(message.author.id, message.guild.id, content, isCommand, isStarter, message.author.username);
    }

    // ── !profile @user — admin behavioural report (no consent required for caller) ──
    if (lower.startsWith(`${PREFIX}profile`) && !lower.startsWith(`${PREFIX}profiles`)) {
      if (!isAdmin) {
        await message.reply("⛔ This command is for admins only.");
        return;
      }

      const target = message.mentions.members?.first();
      if (!target) {
        await message.reply(
          `**Usage:** \`!profile @user\`\n` +
          `Generates a behavioural report based on the user's activity in this server.`,
        );
        return;
      }

      if (!(await hasConsented(target.id))) {
        await message.reply(
          `⚠️ **${target.user.tag}** has not accepted the privacy notice yet.\n` +
          `No data is available — PIXEL only tracks users who have consented.`,
        );
        return;
      }

      await (message.channel as TextChannel).sendTyping().catch(() => {});
      await flushPending();

      const row = await loadProfile(target.id, message.guild.id);
      if (!row || row.msg_count < 10) {
        await message.reply(
          `📭 Not enough data for **${target.user.tag}** yet.\n` +
          `At least 10 messages are needed to generate an accurate report.`,
        );
        return;
      }

      const report = await generateProfileReport(row, target.user.tag);
      const reportText =
        `📊 **Behavioural Report — ${target.user.tag}**\n\n${report}\n\n` +
        `*⚠️ This is a behavioural analysis only — not a personal or psychological diagnosis.*`;

      await message.reply(reportText);

      // Forward to log channel if set
      const logChId = reportChannels.get(message.guild.id);
      if (logChId && logChId !== message.channel.id) {
        const logCh = message.guild.channels.cache.get(logChId) as TextChannel | undefined;
        if (logCh) {
          await logCh.send(
            `📋 Report requested by **${message.author.tag}**\n\n${reportText}`,
          ).catch(() => {});
        }
      }
      return;
    }

    // ── !setprofilechannel #channel | off — admin sets the report log channel ─
    if (lower.startsWith(`${PREFIX}setprofilechannel`)) {
      if (!isAdmin) {
        await message.reply("⛔ This command is for admins only.");
        return;
      }

      const arg = content.slice(`${PREFIX}setprofilechannel`.length).trim().toLowerCase();

      if (arg === "off" || arg === "disable") {
        await setReportChannel(message.guild.id, null);
        await message.reply("✅ Profile report log channel has been **disabled**.");
        return;
      }

      const mentioned = message.mentions.channels.first();
      if (!mentioned || mentioned.type !== ChannelType.GuildText) {
        const current = reportChannels.get(message.guild.id);
        await message.reply(
          `**Usage:** \`!setprofilechannel #channel\` — forward all \`!profile\` reports to that channel.\n` +
          `\`!setprofilechannel off\` — disable forwarding.\n\n` +
          (current ? `📌 Current log channel: <#${current}>` : `📌 No log channel set.`),
        );
        return;
      }

      await setReportChannel(message.guild.id, mentioned.id);
      await message.reply(`✅ Profile reports will now be forwarded to <#${mentioned.id}>.`);
      return;
    }

    // ── !myprofile — user views their own stats ───────────────────────────────
    if (lower === `${PREFIX}myprofile`) {
      if (!(await hasConsented(message.author.id))) {
        await message.reply(
          `⚠️ You haven't accepted the privacy notice yet, so no data has been collected.\n` +
          `Type \`!accept\` to get started.`,
        );
        return;
      }

      await flushPending();
      const row = await loadProfile(message.author.id, message.guild.id);

      if (!row || row.msg_count < 5) {
        await message.reply("📭 Not enough data about you yet. Keep chatting in the server!");
        return;
      }

      const topKw = Object.entries(row.keywords as Record<string, number>)
        .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
      const starterRatio = (row.starter_msgs + row.responder_msgs) > 0
        ? Math.round((row.starter_msgs / (row.starter_msgs + row.responder_msgs)) * 100) : 0;

      await message.reply([
        `📊 **Your stats in this server**`,
        ``,
        `📨 Total messages: **${row.msg_count}**`,
        `⌨️ Commands used: **${row.cmd_count}**`,
        `🕐 Peak hours: **${peakHours(row.hour_counts)}**`,
        `💬 Starts conversations: **${starterRatio}%** of the time`,
        `🏷️ Top topics: ${topKw.length > 0 ? topKw.join(", ") : "—"}`,
        `📅 First seen: ${new Date(row.first_seen).toLocaleDateString("en-GB")}`,
        ``,
        `*Use \`!forget\` to erase all your data.*`,
      ].join("\n"));
      return;
    }
  });
}
