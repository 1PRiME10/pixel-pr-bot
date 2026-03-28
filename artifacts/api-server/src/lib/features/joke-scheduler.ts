import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";
import { createHash } from "crypto";

// 5 UTC hours when quotes are auto-posted (00:00, 05:00, 10:00, 15:00, 20:00)
const JOKE_HOURS_UTC = [0, 5, 10, 15, 20];

// ─── Source pool — 80+ diverse titles ────────────────────────────────────────
const SERIES_POOL = [
  // Shonen / Action
  "Fullmetal Alchemist: Brotherhood", "Naruto Shippuden", "One Piece",
  "Attack on Titan", "Demon Slayer", "Hunter x Hunter", "Death Note",
  "Bleach", "Dragon Ball Z", "My Hero Academia", "Black Clover",
  "Jujutsu Kaisen", "Chainsaw Man", "Blue Lock", "Haikyuu!!",
  "Slam Dunk", "Kuroko's Basketball", "JoJo's Bizarre Adventure",
  "Mob Psycho 100", "One Punch Man", "Vinland Saga", "Berserk",
  "Sword Art Online", "The Rising of the Shield Hero", "Overlord",
  "That Time I Got Reincarnated as a Slime", "No Game No Life",
  "Re:Zero", "Mushishi", "Made in Abyss",
  // Sci-Fi / Mecha
  "Steins;Gate", "Code Geass", "Neon Genesis Evangelion", "Cowboy Bebop",
  "Gurren Lagann", "Ghost in the Shell", "Trigun", "Psycho-Pass",
  "Akira", "Aldnoah.Zero",
  // Drama / Slice of Life
  "Violet Evergarden", "Your Lie in April", "Anohana", "Clannad",
  "Toradora", "Fruits Basket", "Erased", "A Silent Voice (film)",
  "Kaguya-sama: Love Is War", "Spy × Family", "Nichijou",
  "March Comes in Like a Lion", "Barakamon", "Silver Spoon",
  "Plastic Memories", "Angel Beats!", "Charlotte", "Your Name (film)",
  // Ghibli / Films
  "Spirited Away", "Princess Mononoke", "Howl's Moving Castle",
  "Nausicaä of the Valley of the Wind", "Castle in the Sky",
  "My Neighbor Totoro", "Grave of the Fireflies", "The Wind Rises",
  "Wolfwalkers", "Weathering with You", "The Boy and the Heron",
  "I Want to Eat Your Pancreas (film)", "5 Centimeters per Second",
  // Fantasy / Isekai
  "Madoka Magica", "Sword Art Online: Alicization", "Fate/Zero",
  "Fate/Stay Night: Unlimited Blade Works", "Re:Zero",
  "Konosuba", "The Eminence in Shadow", "Classroom of the Elite",
  "Irregular at Magic High School", "Is It Wrong to Try to Pick Up Girls in a Dungeon?",
  // Manga originals
  "Vagabond (manga)", "Berserk (manga)", "Goodnight Punpun (manga)",
  "Oyasumi Punpun (manga)", "Dungeon Meshi", "Pluto (manga)",
  "20th Century Boys (manga)", "Monster (manga)",
];

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]!);
  }
  return result;
}

function hashQuote(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initJokeScheduler(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS joke_schedule (
      guild_id    TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quote_history (
      id          SERIAL PRIMARY KEY,
      content_hash TEXT NOT NULL,
      quote_text  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS quote_history_hash_idx ON quote_history (content_hash)
  `).catch(() => {});
}

export async function setJokeChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO joke_schedule (guild_id, channel_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
    [guildId, channelId],
  );
}

export async function removeJokeChannel(guildId: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM joke_schedule WHERE guild_id = $1`,
    [guildId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getJokeScheduleChannel(guildId: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT channel_id FROM joke_schedule WHERE guild_id = $1`,
    [guildId],
  );
  return res.rows[0]?.channel_id ?? null;
}

// ─── Quote generation ─────────────────────────────────────────────────────────
async function getRecentQuoteHashes(): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT content_hash FROM quote_history ORDER BY created_at DESC LIMIT 50`,
  );
  return new Set(res.rows.map((r: any) => r.content_hash as string));
}

async function saveQuoteHistory(quoteText: string): Promise<void> {
  const hash = hashQuote(quoteText);
  await pool.query(
    `INSERT INTO quote_history (content_hash, quote_text) VALUES ($1, $2)`,
    [hash, quoteText.slice(0, 1000)],
  );
  // Keep only last 200 entries
  await pool.query(
    `DELETE FROM quote_history WHERE id NOT IN (
       SELECT id FROM quote_history ORDER BY created_at DESC LIMIT 200
     )`,
  ).catch(() => {});
}

export async function generateAndSendJoke(channel: TextChannel, attempt = 0): Promise<void> {
  if (attempt > 3) {
    console.warn("[QuoteScheduler] Max retries reached — skipping this slot");
    return;
  }

  const recentHashes = await getRecentQuoteHashes();
  const picks = pickRandom(SERIES_POOL, 4);

  const prompt = `You are a curator of memorable quotes from anime, manga, and animated films.

Pick ONE real, meaningful, or clever quote from ONE of these works:
${picks.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Rules:
- Use an ACTUAL quote from the work — do not invent one
- Vary the theme each time: wisdom, humor, motivation, sadness, love, courage, philosophy
- The quote must be complete and make sense on its own
- Keep it under 200 characters
- If you cannot recall an actual quote from any of those, choose a DIFFERENT well-known anime/manga/film and use a real quote from it

Format your response EXACTLY like this (nothing else, no extra text):
[Quote text]
— Character Name, *Series Title*`;

  const raw = await generateWithFallback({ contents: [{ role: "user", parts: [{ text: prompt }] }] });

  if (!raw || raw.trim().length < 10) {
    console.warn("[QuoteScheduler] AI returned empty — retrying");
    return generateAndSendJoke(channel, attempt + 1);
  }

  const quoteText = raw.trim();
  const hash = hashQuote(quoteText);

  if (recentHashes.has(hash)) {
    console.log(`[QuoteScheduler] Duplicate detected (attempt ${attempt + 1}) — retrying`);
    return generateAndSendJoke(channel, attempt + 1);
  }

  await saveQuoteHistory(quoteText);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("💬 Anime & Manga Quote")
    .setDescription(quoteText)
    .setTimestamp()
    .setFooter({ text: "Auto-posted by PIXEL_PR" });

  await channel.send({ embeds: [embed] });
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
export function registerJokeScheduler(client: Client): void {
  let lastPostedHour = -1;

  setInterval(async () => {
    const now       = new Date();
    const hourUTC   = now.getUTCHours();
    const minuteUTC = now.getUTCMinutes();

    if (!JOKE_HOURS_UTC.includes(hourUTC)) return;
    if (minuteUTC >= 5) return;
    if (lastPostedHour === hourUTC) return;

    lastPostedHour = hourUTC;
    console.log(`[QuoteScheduler] Scheduled post at UTC ${hourUTC}:00`);

    try {
      const rows = await pool.query(`SELECT guild_id, channel_id FROM joke_schedule`).then(r => r.rows);
      for (const row of rows) {
        try {
          const ch = (
            client.channels.cache.get(row.channel_id) ??
            await client.channels.fetch(row.channel_id).catch(() => null)
          ) as TextChannel | null;

          if (!ch) {
            console.warn(`[QuoteScheduler] Channel ${row.channel_id} not found for guild ${row.guild_id}`);
            continue;
          }

          await generateAndSendJoke(ch);
          console.log(`[QuoteScheduler] ✅ Posted to ${row.channel_id} (guild ${row.guild_id})`);
        } catch (e) {
          console.error(`[QuoteScheduler] ❌ Failed for guild ${row.guild_id}:`, e);
        }
      }
    } catch (e) {
      console.error("[QuoteScheduler] DB error:", e);
    }
  }, 60_000);
}
