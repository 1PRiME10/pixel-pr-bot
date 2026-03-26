import { isClaimed } from "../message-gate.js";
import {
  Client,
  Events,
  Message,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { pool } from "@workspace/db";

// ─── Self-contained profanity warning system (persisted to DB) ───────────────
const _pfWarnings = new Map<string, Map<string, string[]>>();

async function addWarningAndCheck(
  guildId: string,
  userId: string,
  reason: string,
  member: GuildMember,
  notifyChannel?: TextChannel,
): Promise<void> {
  if (!_pfWarnings.has(guildId)) _pfWarnings.set(guildId, new Map());
  const guildWarns = _pfWarnings.get(guildId)!;
  const list = guildWarns.get(userId) ?? [];
  list.push(reason);
  guildWarns.set(userId, list);
  const count = list.length;

  // Persist to DB
  try {
    await pool.query(
      `INSERT INTO user_warnings (guild_id, user_id, reason, source) VALUES ($1, $2, $3, 'profanity')`,
      [guildId, userId, reason]
    );
  } catch (err) {
    console.error("[ProfanityFilter] Failed to persist warning to DB:", err);
  }

  if (count === 3) {
    try {
      await member.send(`⚠️ You have 3 profanity violations in **${member.guild.name}** and have been auto-kicked.\nLatest: ${reason}`).catch(() => {});
      await member.kick("Profanity filter: 3 violations");
      await notifyChannel?.send(`🦶 ${member.user.tag} auto-kicked after 3 profanity violations.`).catch(() => {});
    } catch {}
  }
  if (count >= 5) {
    try {
      await member.send(`🔨 You have 5+ profanity violations in **${member.guild.name}** and have been auto-banned.`).catch(() => {});
      await member.ban({ reason: "Profanity filter: 5 violations" });
      await notifyChannel?.send(`🔨 ${member.user.tag} auto-banned after 5 profanity violations.`).catch(() => {});
    } catch {}
  }
}

// ─── Per-guild word blacklists (in-memory + DB-backed) ───────────────────────
const blacklists = new Map<string, Set<string>>();

export function getBlacklist(guildId: string): Set<string> {
  if (!blacklists.has(guildId)) blacklists.set(guildId, new Set());
  return blacklists.get(guildId)!;
}

function containsBadWord(content: string, list: Set<string>): string | null {
  const lower = content.toLowerCase();
  for (const word of list) {
    if (lower.includes(word)) return word;
  }
  return null;
}

// ─── DB init: create tables and load data into memory ────────────────────────
export async function initProfanityFilter(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profanity_blacklist (
      guild_id TEXT NOT NULL,
      word     TEXT NOT NULL,
      PRIMARY KEY (guild_id, word)
    )
  `);

  // Load existing blacklists
  const { rows: blRows } = await pool.query<{ guild_id: string; word: string }>(
    `SELECT guild_id, word FROM profanity_blacklist`
  );
  for (const row of blRows) {
    if (!blacklists.has(row.guild_id)) blacklists.set(row.guild_id, new Set());
    blacklists.get(row.guild_id)!.add(row.word);
  }
  console.log(`[ProfanityFilter] Loaded ${blRows.length} blacklisted word(s) from DB`);

  // Load persisted profanity warnings into memory
  try {
    const { rows: warnRows } = await pool.query<{ guild_id: string; user_id: string; reason: string }>(
      `SELECT guild_id, user_id, reason FROM user_warnings WHERE source = 'profanity' ORDER BY id`
    );
    for (const row of warnRows) {
      if (!_pfWarnings.has(row.guild_id)) _pfWarnings.set(row.guild_id, new Map());
      const guildWarns = _pfWarnings.get(row.guild_id)!;
      const list = guildWarns.get(row.user_id) ?? [];
      list.push(row.reason);
      guildWarns.set(row.user_id, list);
    }
    console.log(`[ProfanityFilter] Loaded ${warnRows.length} profanity warning(s) from DB`);
  } catch {
    // user_warnings table may not exist yet; safe to ignore
  }
}

export function registerProfanityFilter(client: Client) {
  // ── Filter messages ───────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

    const list = getBlacklist(message.guild.id);
    if (list.size === 0) return;

    const found = containsBadWord(message.content, list);
    if (!found) return;

    await message.delete().catch(() => {});

    const warning = await (message.channel as any).send(
      `🚫 ${message.author}, your message was removed for containing a prohibited word.`
    );
    setTimeout(() => warning.delete().catch(() => {}), 5_000);

    // Auto-warn the user
    if (message.member) {
      await addWarningAndCheck(
        message.guild.id,
        message.author.id,
        `Prohibited word used: "${found}"`,
        message.member,
        message.channel as TextChannel
      );
    }
  });

  // ── Commands: !addword / !removeword / !wordlist / !clearwords ────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim();
    if (!content.startsWith("!")) return;

    const args = content.slice(1).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();
    const list = getBlacklist(message.guild.id);
    const guildId = message.guild.id;

    if (command === "addword") {
      const words = args.map((w) => w.toLowerCase()).filter(Boolean);
      if (!words.length) return void message.reply("Usage: `!addword <word1> [word2] ...`");
      const newWords = words.filter((w) => !list.has(w));
      newWords.forEach((w) => list.add(w));
      // Persist to DB
      if (newWords.length > 0) {
        try {
          const values = newWords.map((_, i) => `($1, $${i + 2})`).join(", ");
          await pool.query(
            `INSERT INTO profanity_blacklist (guild_id, word) VALUES ${values} ON CONFLICT DO NOTHING`,
            [guildId, ...newWords]
          );
        } catch (err) {
          console.error("[ProfanityFilter] Failed to persist blacklist to DB:", err);
        }
      }
      await message.reply(`✅ Added **${newWords.length}** word(s) to the blacklist. Total: **${list.size}**.`);
    }

    if (command === "removeword") {
      const words = args.map((w) => w.toLowerCase()).filter(Boolean);
      if (!words.length) return void message.reply("Usage: `!removeword <word1> [word2] ...`");
      const removed = words.filter((w) => { const had = list.has(w); list.delete(w); return had; });
      // Persist to DB
      if (removed.length > 0) {
        try {
          await pool.query(
            `DELETE FROM profanity_blacklist WHERE guild_id = $1 AND word = ANY($2)`,
            [guildId, removed]
          );
        } catch (err) {
          console.error("[ProfanityFilter] Failed to remove words from DB:", err);
        }
      }
      await message.reply(
        removed.length
          ? `✅ Removed **${removed.length}** word(s). Total remaining: **${list.size}**.`
          : "❌ None of those words were in the blacklist."
      );
    }

    if (command === "wordlist") {
      if (list.size === 0) return void message.reply("📋 The word blacklist is currently empty. Use `!addword` to add words.");
      const words = [...list].join(", ");
      await message.reply({ content: `📋 **Blacklisted words (${list.size}):**\n||${words}||` });
    }

    if (command === "clearwords") {
      list.clear();
      try {
        await pool.query(`DELETE FROM profanity_blacklist WHERE guild_id = $1`, [guildId]);
      } catch (err) {
        console.error("[ProfanityFilter] Failed to clear words from DB:", err);
      }
      await message.reply("✅ Word blacklist cleared.");
    }
  });
}
