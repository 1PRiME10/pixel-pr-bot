import { isClaimed } from "../message-gate.js";
// ─── AI Sentiment & Trend Radar ───────────────────────────────────────────────
// Monitors server activity silently, then sends a daily AI-generated briefing
// to a designated admin channel. Admins can also request instant reports.
//
// Security:
//  • Only admins can configure or manually trigger the report
//  • Only message counts + short samples are stored in memory (no full logs)
//  • Message samples are capped at 200 chars each, max 20 per channel
//  • Stats are reset after each daily report — no long-term message storage

import { Client, Message, TextChannel, ChannelType, PermissionFlagsBits } from "discord.js";
import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

// ── Types ────────────────────────────────────────────────────────────────────
interface ChannelStats {
  name:           string;
  messageCount:   number;
  sampleMessages: string[];  // capped at MAX_SAMPLES
  wordFreq:       Map<string, number>;
}

// guildId → channelId → stats
const dailyStats = new Map<string, Map<string, ChannelStats>>();
const MAX_SAMPLES = 20;

// ── In-memory config cache (avoids DB round-trip on every message) ────────────
const _sentimentCache = new Map<string, string | null>(); // guildId → channelId | null

// ── DB ────────────────────────────────────────────────────────────────────────
export async function initSentiment(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sentiment_config (
      guild_id          TEXT PRIMARY KEY,
      report_channel_id TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Pre-warm cache at startup
  const { rows } = await pool.query(`SELECT guild_id, report_channel_id FROM sentiment_config`);
  for (const r of rows) _sentimentCache.set(r.guild_id, r.report_channel_id);
}

async function getReportChannelId(guildId: string): Promise<string | null> {
  if (_sentimentCache.has(guildId)) return _sentimentCache.get(guildId)!;
  const { rows } = await pool.query(
    `SELECT report_channel_id FROM sentiment_config WHERE guild_id = $1`,
    [guildId],
  );
  const val = rows[0]?.report_channel_id ?? null;
  _sentimentCache.set(guildId, val);
  return val;
}

export async function setReportChannelId(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO sentiment_config (guild_id, report_channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET report_channel_id = EXCLUDED.report_channel_id`,
    [guildId, channelId],
  );
  _sentimentCache.set(guildId, channelId);
}

// ── Record a message (in-memory only) ────────────────────────────────────────
function recordMessage(
  guildId:     string,
  channelId:   string,
  channelName: string,
  content:     string,
): void {
  if (!dailyStats.has(guildId)) dailyStats.set(guildId, new Map());
  const guildData = dailyStats.get(guildId)!;

  if (!guildData.has(channelId)) {
    guildData.set(channelId, { name: channelName, messageCount: 0, sampleMessages: [], wordFreq: new Map() });
  }
  const stats = guildData.get(channelId)!;
  stats.name = channelName;
  stats.messageCount++;

  // Collect samples (skip commands and very short messages)
  if (content.length > 10 && !content.startsWith("!") && stats.sampleMessages.length < MAX_SAMPLES) {
    stats.sampleMessages.push(content.slice(0, 200));
  }

  // Word frequency — used to surface trending topics
  for (const raw of content.toLowerCase().split(/\s+/)) {
    const word = raw.replace(/[^a-z0-9أ-يa-zA-Z]/gu, "");
    if (word.length > 3) stats.wordFreq.set(word, (stats.wordFreq.get(word) ?? 0) + 1);
  }
}

// ── Generate AI briefing for one guild ───────────────────────────────────────
export async function generateBriefing(guildId: string, guildName: string): Promise<string> {
  const guildData = dailyStats.get(guildId);
  if (!guildData || guildData.size === 0) {
    return "📊 **Daily Briefing**\n\nNo activity recorded in the server today.";
  }

  const totalMessages = [...guildData.values()].reduce((s, c) => s + c.messageCount, 0);

  const topChannels = [...guildData.entries()]
    .sort((a, b) => b[1].messageCount - a[1].messageCount)
    .slice(0, 6);

  const summaries = topChannels.map(([chId, stats]) => {
    const topWords = [...stats.wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([w]) => w);

    return (
      `Channel #${stats.name} (<#${chId}>): ${stats.messageCount} messages. ` +
      `Sample messages: "${stats.sampleMessages.slice(0, 4).join('" | "')}". ` +
      `Frequent words: ${topWords.join(", ")}.`
    );
  });

  const activityLevel =
    totalMessages > 500 ? "very active" :
    totalMessages > 200 ? "active" :
    totalMessages > 50  ? "moderate" : "quiet";

  const prompt =
    `You are an AI analyst for the Discord server "${guildName}".\n\n` +
    `Write a friendly daily briefing report IN ENGLISH for the server admin.\n\n` +
    `Today's data:\n` +
    `- Total messages: ${totalMessages} (${activityLevel} day)\n` +
    `- Active channels: ${guildData.size}\n` +
    summaries.join("\n") +
    `\n\nWrite 5-8 sentences that:\n` +
    `1. Open with the overall activity level for today\n` +
    `2. Highlight the most active channel(s) and what members were discussing\n` +
    `3. Point out any trending topics or recurring themes\n` +
    `4. Give 1-2 practical suggestions for the admin (e.g. open a discussion, pin a topic)\n` +
    `5. End with a brief positive closing note\n\n` +
    `Format with Discord markdown. Use emojis naturally. Be concise and insightful. Write entirely in English.`;

  const text = await generateWithFallback({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    maxOutputTokens: 1024,
  });
  if (!text) {
    console.warn("[Sentiment] All AI models rate-limited — skipping briefing");
    return `📊 **Daily Briefing — ${guildName}**\n\n⚠️ The AI service is temporarily busy. Please try again in a minute with \`/briefing\`.`;
  }
  return `📊 **Daily Briefing — ${guildName}**\n\n${text}`;
}

// ── Midnight scheduler ────────────────────────────────────────────────────────
function startDailyScheduler(client: Client): void {
  let lastReportDate = "";

  setInterval(async () => {
    const now        = new Date();
    const todayLabel = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Fire once per day at 00:00 UTC
    if (now.getUTCHours() !== 0 || now.getUTCMinutes() !== 0) return;
    if (lastReportDate === todayLabel) return;
    lastReportDate = todayLabel;

    let rows: { guild_id: string; report_channel_id: string }[] = [];
    try {
      ({ rows } = await pool.query(`SELECT guild_id, report_channel_id FROM sentiment_config`));
    } catch { return; }

    for (const row of rows) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (!guild) continue;
      const ch = guild.channels.cache.get(row.report_channel_id) as TextChannel | undefined;
      if (!ch) continue;

      const briefing = await generateBriefing(row.guild_id, guild.name);
      ch.send(briefing).catch(console.error);

      // Reset stats after sending
      dailyStats.delete(row.guild_id);
    }
  }, 60_000); // check every minute
}

// ── Register ──────────────────────────────────────────────────────────────────
export function registerSentiment(client: Client, PREFIX: string): void {
  initSentiment().catch(console.error);
  startDailyScheduler(client);

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.guild)     return;

    const isTextChannel = message.channel.type === ChannelType.GuildText;

    // Record every text-channel message silently
    if (isTextChannel) {
      recordMessage(
        message.guild.id,
        message.channel.id,
        (message.channel as TextChannel).name,
        message.content,
      );
    }

    // ── Admin commands ───────────────────────────────────────────────────────
    const content = message.content.trim();
    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

    // !setreport #channel — configure where daily briefings are sent
    if (content.toLowerCase().startsWith(`${PREFIX}setreport`)) {
      if (!isAdmin) {
        await message.reply("⛔ This command is for admins only.");
        return;
      }
      const mentioned = message.mentions.channels.first() as TextChannel | undefined;
      if (!mentioned || mentioned.type !== ChannelType.GuildText) {
        await message.reply(`**Usage:** \`!setreport #channel\``);
        return;
      }
      await setReportChannelId(message.guild.id, mentioned.id);
      await message.reply(
        `✅ Daily briefing will be sent to ${mentioned} automatically at midnight (UTC).\n` +
        `You can request an instant report now with \`!briefing\``,
      );
      return;
    }

    // !briefing — instant manual report
    if (content.toLowerCase() === `${PREFIX}briefing`) {
      if (!isAdmin) {
        await message.reply("⛔ This command is for admins only.");
        return;
      }
      await (message.channel as any).sendTyping();
      const briefing = await generateBriefing(message.guild.id, message.guild.name);
      await message.reply(briefing);
      return;
    }
  });
}
