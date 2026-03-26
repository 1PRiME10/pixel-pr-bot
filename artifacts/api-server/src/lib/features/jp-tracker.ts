import { isClaimed } from "../message-gate.js";
// ─── JP Event Live Tracker — "رادار التوقيت الياباني" ────────────────────────
// Syncs with Japan Standard Time (JST = UTC+9) to deliver real-time anime-
// atmosphere events to your Discord server.
//
// Features:
//   • !jptime              — current Tokyo time + mood/vibe label
//   • !jpairing            — what's airing in Japan RIGHT NOW (AniList)
//   • !setjpchannel #ch    — set alert channel (admin)
//   • !jpalerts on/off     — toggle scheduled vibe alerts (admin)
//   Automatic alerts:
//     🌙 Midnight in Tokyo (00:00 JST)  — "midnight anime hour"
//     🌅 Morning in Tokyo (07:00 JST)   — good morning vibe
//     🌆 Golden Time (19:00 JST)        — prime-time anime block begins
//     🎌 Late Night (23:00 JST)         — late-night anime block

import { Client, Message, TextChannel, ChannelType, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { pool } from "@workspace/db";

// Self-contained dedup — prevents this feature from processing the same message twice
const _jpSeen = new Set<string>();
function jpClaim(id: string): boolean {
  if (_jpSeen.has(id)) return false;
  _jpSeen.add(id);
  setTimeout(() => _jpSeen.delete(id), 30_000);
  return true;
}

let jpPollRegistered = false;
let jpActiveClient: Client | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────
function tokyoNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
}

function formatTokyoTime(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "long", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function tokyoVibe(h: number): { emoji: string; label: string; desc: string } {
  if (h >= 0  && h < 4)  return { emoji: "🌙", label: "Deep Night (深夜)",    desc: "The sacred anime hour. Tokyo sleeps, but manga readers don't." };
  if (h >= 4  && h < 7)  return { emoji: "🌌", label: "Pre-Dawn (夜明け前)",  desc: "The city starts to breathe again. Convenience stores are in full swing." };
  if (h >= 7  && h < 10) return { emoji: "🌅", label: "Morning (朝)",         desc: "Morning commute. Tokyo is alive and rushing." };
  if (h >= 10 && h < 12) return { emoji: "☀️", label: "Late Morning (午前)",  desc: "Akihabara shops opening up. Idols practicing." };
  if (h >= 12 && h < 14) return { emoji: "🍱", label: "Lunchtime (昼)",       desc: "Bento boxes and figure shopping in Akihabara." };
  if (h >= 14 && h < 17) return { emoji: "🌤️", label: "Afternoon (午後)",    desc: "Cafés and doujin artists at work." };
  if (h >= 17 && h < 19) return { emoji: "🌇", label: "Evening (夕方)",       desc: "Sunset over Tokyo Tower. Shounen airing soon." };
  if (h >= 19 && h < 23) return { emoji: "🎌", label: "Golden Time (黄金時間)", desc: "Prime-time anime block. The whole country is watching." };
  return                         { emoji: "🌃", label: "Late Night (深夜)",    desc: "Late-night anime block. The good stuff airs now." };
}

// ── AniList: what's airing in Japan right now ─────────────────────────────────
async function getAiringNow(): Promise<Array<{ title: string; episode: number; airingAt: number; cover: string }>> {
  const nowSec   = Math.floor(Date.now() / 1000);
  const pastSec  = nowSec - 30 * 60; // last 30 minutes

  const gql = `
    query ($gt: Int, $lt: Int) {
      Page(perPage: 8) {
        airingSchedules(airingAt_greater: $gt, airingAt_lesser: $lt, sort: TIME_DESC) {
          episode airingAt
          media {
            title { romaji english }
            coverImage { medium }
            isAdult
          }
        }
      }
    }`;
  try {
    const res  = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { gt: pastSec, lt: nowSec } }),
    });
    const json = await res.json() as any;
    const list = (json?.data?.Page?.airingSchedules ?? []) as any[];
    return list
      .filter((s: any) => !s.media?.isAdult)
      .map((s: any) => ({
        title:    s.media?.title?.english ?? s.media?.title?.romaji ?? "Unknown",
        episode:  s.episode,
        airingAt: s.airingAt,
        cover:    s.media?.coverImage?.medium ?? "",
      }));
  } catch {
    return [];
  }
}

// ── AniList: airing soon (next 2 hours) ──────────────────────────────────────
async function getAiringSoon(): Promise<Array<{ title: string; episode: number; airingAt: number }>> {
  const nowSec    = Math.floor(Date.now() / 1000);
  const futureSec = nowSec + 2 * 3600;

  const gql = `
    query ($gt: Int, $lt: Int) {
      Page(perPage: 5) {
        airingSchedules(airingAt_greater: $gt, airingAt_lesser: $lt, sort: TIME) {
          episode airingAt
          media { title { romaji english } isAdult }
        }
      }
    }`;
  try {
    const res  = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { gt: nowSec, lt: futureSec } }),
    });
    const json = await res.json() as any;
    const list = (json?.data?.Page?.airingSchedules ?? []) as any[];
    return list
      .filter((s: any) => !s.media?.isAdult)
      .map((s: any) => ({
        title:    s.media?.title?.english ?? s.media?.title?.romaji ?? "Unknown",
        episode:  s.episode,
        airingAt: s.airingAt,
      }));
  } catch {
    return [];
  }
}

// ── DB ────────────────────────────────────────────────────────────────────────
interface JPConfig { channelId: string; alerts: boolean }
export const jpConfigs = new Map<string, JPConfig>();

export async function initJPTracker(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jp_tracker_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      alerts     BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  const { rows } = await pool.query(`SELECT * FROM jp_tracker_config`);
  for (const r of rows) jpConfigs.set(r.guild_id, { channelId: r.channel_id, alerts: r.alerts });
}

export async function saveJPConfig(guildId: string, cfg: JPConfig): Promise<void> {
  jpConfigs.set(guildId, cfg);
  await pool.query(
    `INSERT INTO jp_tracker_config (guild_id, channel_id, alerts)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2, alerts = $3`,
    [guildId, cfg.channelId, cfg.alerts],
  );
}

// ── Scheduled vibe alert checker (runs every minute) ──────────────────────────
let lastAlertHour = -1;

async function checkScheduledAlerts(client: Client): Promise<void> {
  const tokyo = tokyoNow();
  const h     = tokyo.getHours();
  const m     = tokyo.getMinutes();
  if (m !== 0) return;          // only fire on the hour
  if (h === lastAlertHour) return; // already fired this hour
  lastAlertHour = h;

  // Only alert at key hours
  const keyHours: Record<number, { title: string; desc: string; color: number }> = {
    0:  { title: "🌙 Midnight in Tokyo — 真夜中",    desc: "It's **midnight in Tokyo** (深夜 00:00 JST).\nThe late-night anime block has begun. Somewhere in Shinjuku, a new episode just aired without subtitles.",           color: 0x2c2f33 },
    7:  { title: "🌅 Morning in Tokyo — 朝",          desc: "**Good morning from Tokyo!** (朝 07:00 JST)\nThe city is awake. Salary-men are commuting. Anime studios are already at work.",                                    color: 0xffa500 },
    19: { title: "🎌 Golden Time Starts — 黄金時間",  desc: "**Golden Time has begun in Tokyo!** (黄金時間 19:00 JST)\nPrime-time anime is now airing across Japan. The whole country tunes in.",                              color: 0xff4500 },
    23: { title: "🌃 Late-Night Anime Block — 深夜",  desc: "**Late-night anime block begins in Tokyo.** (深夜 23:00 JST)\nThis is where the *actually good* stuff airs — the niche, the dark, the legendary.",               color: 0x7289da },
  };

  const alert = keyHours[h];
  if (!alert) return;

  for (const [guildId, cfg] of jpConfigs) {
    if (!cfg.alerts) continue;
    const ch = client.channels.cache.get(cfg.channelId) as TextChannel | undefined;
    if (!ch) continue;

    const embed = new EmbedBuilder()
      .setColor(alert.color)
      .setTitle(alert.title)
      .setDescription(alert.desc)
      .setFooter({ text: `JP Radar • Tokyo ${String(h).padStart(2, "0")}:00 JST` })
      .setTimestamp();

    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ── Register ──────────────────────────────────────────────────────────────────
export function registerJPTracker(client: Client, PREFIX: string): void {
  jpActiveClient = client;

  if (!jpPollRegistered) {
    jpPollRegistered = true;
    setInterval(() => checkScheduledAlerts(jpActiveClient!).catch(console.error), 60_000);
  }

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.guild) return;

    // Pre-check: only handle JP-tracker commands
    const lower = message.content.trim().toLowerCase();
    const isJPCmd = ["jptime", "jpairing", "setjpchannel", "jpalerts"]
      .some(cmd => lower === `${PREFIX}${cmd}` || lower.startsWith(`${PREFIX}${cmd} `));
    if (!isJPCmd) return;

    // Allow GuildText AND threads
    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.GuildPublicThread,
      ChannelType.GuildPrivateThread,
      ChannelType.GuildNewsThread,
    ] as number[];
    if (!allowedTypes.includes(message.channel.type)) return;

    // Self-contained dedup — prevents double-response within this feature
    if (!jpClaim(message.id)) return;

    const content = message.content.trim();
    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

    // ── !jptime ──────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}jptime`) {
      const tokyo = tokyoNow();
      const h     = tokyo.getHours();
      const vibe  = tokyoVibe(h);
      const embed = new EmbedBuilder()
        .setColor(0xbc002d) // Japan red
        .setTitle(`🇯🇵 Tokyo Time — ${vibe.emoji} ${vibe.label}`)
        .setDescription(
          `**${formatTokyoTime(tokyo)}**\n\n` +
          `*${vibe.desc}*`,
        )
        .setFooter({ text: "JST = UTC+9" })
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !jpairing ─────────────────────────────────────────────────────────────
    if (lower === `${PREFIX}jpairing`) {
      await (message.channel as TextChannel).sendTyping().catch(() => {});

      const [nowList, soonList] = await Promise.all([getAiringNow(), getAiringSoon()]);
      const tokyo = tokyoNow();
      const vibe  = tokyoVibe(tokyo.getHours());

      const embed = new EmbedBuilder()
        .setColor(0xbc002d)
        .setTitle(`📺 Airing in Japan — ${vibe.emoji} ${vibe.label}`)
        .setFooter({ text: "Data from AniList • JST times" })
        .setTimestamp();

      if (nowList.length > 0) {
        embed.addFields({
          name: "🔴 Just Aired (last 30 min)",
          value: nowList.map(a =>
            `**${a.title}** — Ep ${a.episode} (<t:${a.airingAt}:R>)`,
          ).join("\n"),
        });
      } else {
        embed.addFields({ name: "🔴 Just Aired", value: "Nothing in the last 30 minutes." });
      }

      if (soonList.length > 0) {
        embed.addFields({
          name: "⏳ Airing Soon (next 2 hours)",
          value: soonList.map(a =>
            `**${a.title}** — Ep ${a.episode} — <t:${a.airingAt}:R>`,
          ).join("\n"),
        });
      }

      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !setjpchannel #channel ────────────────────────────────────────────────
    if (lower.startsWith(`${PREFIX}setjpchannel`)) {
      if (!isAdmin) { await message.reply("⛔ Admins only."); return; }

      const mentioned = message.mentions.channels.first();
      if (!mentioned || mentioned.type !== ChannelType.GuildText) {
        const cfg = jpConfigs.get(message.guild.id);
        await message.reply(
          `**Usage:** \`!setjpchannel #channel\`\n` +
          (cfg ? `📌 Current channel: <#${cfg.channelId}> — Alerts: **${cfg.alerts ? "ON" : "OFF"}**` : "📌 No channel set."),
        );
        return;
      }

      const existing = jpConfigs.get(message.guild.id);
      await saveJPConfig(message.guild.id, { channelId: mentioned.id, alerts: existing?.alerts ?? true });
      await message.reply(`✅ JP Radar alerts will be sent to <#${mentioned.id}>.`);
      return;
    }

    // ── !jpalerts on/off ──────────────────────────────────────────────────────
    if (lower.startsWith(`${PREFIX}jpalerts`)) {
      if (!isAdmin) { await message.reply("⛔ Admins only."); return; }

      const arg = content.slice(PREFIX.length + 8).trim().toLowerCase();
      const cfg = jpConfigs.get(message.guild.id);

      if (!cfg) {
        await message.reply("⚠️ Set a channel first with `!setjpchannel #channel`.");
        return;
      }

      if (arg === "on") {
        await saveJPConfig(message.guild.id, { ...cfg, alerts: true });
        await message.reply("✅ JP Radar scheduled alerts are now **ON** (midnight, morning, golden time, late night).");
      } else if (arg === "off") {
        await saveJPConfig(message.guild.id, { ...cfg, alerts: false });
        await message.reply("🔕 JP Radar scheduled alerts are now **OFF**. You can still use `!jptime` and `!jpairing`.");
      } else {
        await message.reply(
          `**Usage:** \`!jpalerts on\` / \`!jpalerts off\`\n` +
          `Current status: **${cfg.alerts ? "ON" : "OFF"}**`,
        );
      }
      return;
    }
  });
}
