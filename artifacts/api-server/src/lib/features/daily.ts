// ─── Daily Inspiration ─────────────────────────────────────────────────────
// Sends 4 themed messages per day into a configurable guild channel.
//
// Time slots (UTC → UTC+3 local):
//   morning   05:00 UTC  →  08:00  صبح   (تحفيزي)
//   afternoon 11:00 UTC  →  14:00  عصر   (اقتباس أنمي)
//   evening   15:00 UTC  →  18:00  مساء  (حكمة)
//   night     20:00 UTC  →  23:00  ليل   (تأمل)
//
// Commands:
//   !setdaily #channel        — configure the channel (admin)
//   !daily                    — send the nearest slot now (admin)
//   !daily morning|afternoon|evening|night  — send a specific slot (admin)

import {
  Client,
  TextChannel,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
} from "discord.js";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";
import { pool } from "@workspace/db";
import { isFeatureEnabled } from "../feature-registry.js";

// ─── Slot definitions ─────────────────────────────────────────────────────────
interface Slot {
  key: "morning" | "afternoon" | "evening" | "night";
  nameAr: string;
  utcHour: number;
  emoji: string;
  color: number;
  prompt: string;
  fallback: string;
}

const SLOTS: Slot[] = [
  {
    key: "morning",
    nameAr: "Good Morning",
    utcHour: 5,
    emoji: "🌅",
    color: 0xFFB347,
    prompt:
      "Craft a short, inspiring morning message (2-3 sentences) as if spoken by a determined anime protagonist. " +
      "Focus on courage, new beginnings, and overcoming challenges. Use evocative, slightly dramatic language. " +
      "Do NOT use emojis. End with a call to action that fits an anime adventure.",
    fallback:
      "The sun rises, signaling a new quest! Let your spirit ignite and face today's challenges with the heart of a hero. " +
      "Every step forward builds your legend. Go forth and seize your destiny!",
  },
  {
    key: "afternoon",
    nameAr: "Anime Quote",
    utcHour: 11,
    emoji: "⛩️",
    color: 0xE91E8C,
    prompt:
      "Provide a memorable quote from a well-known anime (e.g., Naruto, One Piece, Attack on Titan, Demon Slayer, Fullmetal Alchemist, Death Note, Jujutsu Kaisen, My Hero Academia, Studio Ghibli films, etc.). " +
      "The quote should be either deeply philosophical, fiercely determined, or surprisingly heartwarming. " +
      "Format exactly like this:\n" +
      '**\"[Quote in English]\"**\n' +
      "— [Character Name] · [Anime Name]\n\n" +
      "Ensure variety in anime and character. Keep it concise and impactful. No additional commentary.",
    fallback:
      '**\"If you don\'t take risks, you can\'t create a future!\"**\n' +
      "— Monkey D. Luffy · One Piece",
  },
  {
    key: "evening",
    nameAr: "Evening Wisdom",
    utcHour: 15,
    emoji: "🌙",
    color: 0x7B68EE,
    prompt:
      "Compose a short, reflective evening message (2-3 sentences) imbued with the wisdom of an elder or mentor from an anime world. " +
      "Focus on lessons learned, growth, and finding peace after a day's journey. Use a calm, slightly poetic tone. " +
      "Do NOT use emojis.",
    fallback:
      "As twilight falls, reflect on the battles you've fought and the bonds you've forged. " +
      "Each experience, whether triumph or trial, shapes the hero you are becoming. " +
      "Rest now, for tomorrow's adventure awaits.",
  },
  {
    key: "night",
    nameAr: "Night Thoughts",
    utcHour: 20,
    emoji: "✨",
    color: 0x2C3E7A,
    prompt:
      "Generate a peaceful goodnight message (2-3 sentences) as if whispered by a gentle spirit or guardian from an anime. " +
      "Emphasize tranquility, letting go of worries, and the promise of a new dawn. Use a soothing, slightly mystical tone. " +
      "Do NOT use emojis.",
    fallback:
      "Let the starlight guide your dreams, and release the burdens of the day. " +
      "Even the mightiest heroes need their rest to replenish their spirit. " +
      "May your sleep be deep and your awakening be filled with renewed hope.",
  },
];

let dailyInterval: ReturnType<typeof setInterval> | null = null;

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initDaily(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  // sent_date is part of the PK so each (guild, slot, day) is a unique row.
  // ON CONFLICT DO NOTHING guarantees only ONE instance can claim any given slot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_sent (
      guild_id  TEXT NOT NULL,
      slot_key  TEXT NOT NULL,
      sent_date TEXT NOT NULL,
      PRIMARY KEY (guild_id, slot_key, sent_date)
    )
  `);
  // Migrate old table if it lacks sent_date in PK (safe no-op if already correct)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='daily_sent' AND constraint_type='PRIMARY KEY'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_name='daily_sent' AND column_name='sent_date'
        AND constraint_name IN (
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name='daily_sent' AND constraint_type='PRIMARY KEY'
        )
      ) THEN
        ALTER TABLE daily_sent DROP CONSTRAINT IF EXISTS daily_sent_pkey;
        ALTER TABLE daily_sent ADD PRIMARY KEY (guild_id, slot_key, sent_date);
      END IF;
    END$$
  `).catch(() => {}); // ignore if migration already done
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
async function getConfiguredChannel(
  client: Client,
  guildId: string,
): Promise<TextChannel | null> {
  const res = await pool.query<{ channel_id: string }>(
    "SELECT channel_id FROM daily_config WHERE guild_id = $1",
    [guildId],
  );
  if (!res.rows[0]) return null;
  const ch = client.channels.cache.get(res.rows[0].channel_id);
  return ch instanceof TextChannel ? ch : null;
}

async function wasAlreadySent(
  guildId: string,
  slotKey: string,
  today: string,
): Promise<boolean> {
  const res = await pool.query<{ sent_date: string }>(
    "SELECT sent_date FROM daily_sent WHERE guild_id = $1 AND slot_key = $2",
    [guildId, slotKey],
  );
  return res.rows[0]?.sent_date === today;
}

async function markSent(
  guildId: string,
  slotKey: string,
  today: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO daily_sent (guild_id, slot_key, sent_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, slot_key) DO UPDATE SET sent_date = EXCLUDED.sent_date`,
    [guildId, slotKey, today],
  );
}

// ─── Content generation ───────────────────────────────────────────────────────
async function generateContent(slot: Slot): Promise<string> {
  try {
    const text = await generateWithFallback({
      contents: [{ role: "user", parts: [{ text: slot.prompt }] }],
      maxOutputTokens: 350,
    });
    return text?.trim() || slot.fallback;
  } catch {
    return slot.fallback;
  }
}

// ─── Embed builder ────────────────────────────────────────────────────────────
function buildEmbed(slot: Slot, content: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(slot.color)
    .setTitle(`${slot.emoji}  ${slot.nameAr}`)
    .setDescription(content)
    .setFooter({ text: "PIXEL • React with a flag 🏳️ to translate" })
    .setTimestamp();
}

// ─── Send a slot to a guild ───────────────────────────────────────────────────
async function sendSlotToGuild(
  client: Client,
  slot: Slot,
  guildId: string,
): Promise<void> {
  const channel = await getConfiguredChannel(client, guildId);
  if (!channel) return;

  const content = await generateContent(slot);
  const embed = buildEmbed(slot, content);
  await channel.send({ embeds: [embed] }).catch(console.error);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
export function registerDaily(client: Client): void {
  if (dailyInterval) clearInterval(dailyInterval);

  dailyInterval = setInterval(async () => {
    if (!isFeatureEnabled("daily")) return;

    const now = new Date();
    if (now.getUTCMinutes() !== 0) return;

    const slot = SLOTS.find((s) => s.utcHour === now.getUTCHours());
    if (!slot) return;

    const today = now.toISOString().slice(0, 10);

    for (const guild of client.guilds.cache.values()) {
      try {
        // Atomic claim: (guild_id, slot_key, sent_date) is unique PK.
        // Only the FIRST instance to INSERT wins — all others get rowCount=0.
        const claimed = await pool.query(
          `INSERT INTO daily_sent (guild_id, slot_key, sent_date)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING guild_id`,
          [guild.id, slot.key, today]
        );
        if ((claimed.rowCount ?? 0) === 0) continue; // another instance already claimed
        await sendSlotToGuild(client, slot, guild.id);
      } catch (e) {
        console.error(`[daily] scheduler error for guild ${guild.id}:`, e);
      }
    }
  }, 60_000);
}

// ─── Command handler ──────────────────────────────────────────────────────────
// Called from discord-bot.ts for !setdaily and !daily commands.
export async function handleDailyCommand(
  message: Message,
  command: string,
  args: string[],
): Promise<boolean> {
  if (!["setdaily", "daily"].includes(command)) return false;

  const isAdmin = message.member?.permissions.has(
    PermissionFlagsBits.Administrator,
  );
  if (!isAdmin) {
    await message.reply("🔒 You need Administrator permission to use this command.");
    return true;
  }

  const guildId = message.guild!.id;

  // !setdaily #channel
  if (command === "setdaily") {
    const mentioned = message.mentions.channels.first() as
      | TextChannel
      | undefined;
    if (!mentioned || !mentioned.isTextBased()) {
      await message.reply(
        "❌ Usage: `!setdaily #channel`\nExample: `!setdaily #daily-inspiration`",
      );
      return true;
    }
    await pool.query(
      `INSERT INTO daily_config (guild_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
      [guildId, mentioned.id],
    );
    await message.reply(
      `✅ Daily inspiration channel set to ${mentioned}\n\n` +
        "📅 **Auto-send schedule (UTC+3):**\n" +
        "🌅 **08:00** — Good morning (motivational)\n" +
        "⛩️ **14:00** — Anime quote\n" +
        "🌙 **18:00** — Evening wisdom\n" +
        "✨ **23:00** — Night reflection",
    );
    return true;
  }

  // !daily [slot]
  if (command === "daily") {
    if (!isFeatureEnabled("daily")) {
      await message.reply("❌ The daily inspiration feature is currently disabled.");
      return true;
    }

    const channel = await getConfiguredChannel(
      message.client,
      guildId,
    );
    if (!channel) {
      await message.reply(
        "❌ No channel configured yet. Use `!setdaily #channel` first.",
      );
      return true;
    }

    const slotKey = args[0]?.toLowerCase();
    const slot = slotKey
      ? SLOTS.find((s) => s.key === slotKey)
      : (() => {
          const hour = new Date().getUTCHours();
          return (
            SLOTS.reduce((prev, curr) =>
              Math.abs(curr.utcHour - hour) < Math.abs(prev.utcHour - hour)
                ? curr
                : prev,
            ) ?? SLOTS[0]
          );
        })();

    if (!slot) {
      await message.reply(
        "❌ Invalid slot. Options: `morning` `afternoon` `evening` `night`",
      );
      return true;
    }

    await message.reply(`⏳ Sending... (${slot.key})`);
    const content = await generateContent(slot);
    const embed = buildEmbed(slot, content);
    await channel.send({ embeds: [embed] }).catch(console.error);
    return true;
  }

  return false;
}
