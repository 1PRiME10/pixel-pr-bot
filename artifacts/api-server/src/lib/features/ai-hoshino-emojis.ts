// ─── Ai Hoshino Expression Emojis ─────────────────────────────────────────────
// Uploads character expression PNGs as custom emojis to each guild and caches
// the emoji IDs in PostgreSQL so they survive bot restarts.
//
// Exported utilities used by the AI chat reply handler:
//   pickEmoji(emotion, guildId?, personaName?) — returns custom emoji or Unicode fallback
//   parseEmotion(text)                          — strips [E:emotion] tag injected by the AI

import { Guild, PermissionFlagsBits } from "discord.js";
import { pool } from "@workspace/db";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Types ────────────────────────────────────────────────────────────────────
export type ExpressionKey =
  | "happy" | "thinking" | "shocked" | "cool" | "sad" | "laugh"
  | "love" | "angry" | "sleepy" | "nervous" | "wink" | "embarrassed" | "smug" | "cry"
  | "excited" | "bored" | "confused" | "shy" | "proud" | "sparkle";

const AI_EMOTIONS: ExpressionKey[] = [
  "happy", "thinking", "shocked", "cool", "sad", "laugh",
  "love", "angry", "sleepy", "nervous", "wink", "embarrassed", "smug", "cry",
  "excited", "bored", "confused", "shy", "proud", "sparkle",
];

// ─── Unicode fallbacks — Ai Hoshino (default, star idol themed) ───────────────
const AI_HOSHINO_EMOJIS: Record<ExpressionKey, string[]> = {
  happy:       ["⭐", "✨", "🌟", "💫", "🥰"],
  thinking:    ["🤔", "💭", "🫠", "🌸", "🫧"],
  shocked:     ["😲", "🤯", "💥", "🌠", "😳"],
  cool:        ["🌟", "💅", "👑", "💎", "✨"],
  sad:         ["🥺", "💔", "😔", "🌧️", "💧"],
  laugh:       ["😂", "🌸", "💫", "😭", "✨"],
  love:        ["💖", "🥰", "💗", "❤️", "💕"],
  angry:       ["😠", "💢", "🔥", "😤", "⚡"],
  sleepy:      ["😴", "💤", "🌙", "😪", "🫠"],
  nervous:     ["😰", "😅", "💦", "🫣", "😬"],
  wink:        ["😉", "✨", "🌸", "💫", "😏"],
  embarrassed: ["😳", "🌸", "💦", "🫣", "😖"],
  smug:        ["😏", "💅", "👑", "😌", "✨"],
  cry:         ["😭", "💦", "💔", "😢", "🌧️"],
  excited:     ["🎉", "🤩", "⚡", "🔥", "🎊"],
  bored:       ["😑", "💤", "🫥", "😒", "🙄"],
  confused:    ["😵", "❓", "🌀", "🫨", "🤨"],
  shy:         ["🙈", "🌸", "😶", "🫣", "💓"],
  proud:       ["🏆", "💪", "👑", "🌟", "✨"],
  sparkle:     ["✨", "⭐", "🌟", "💫", "🎆"],
};

// ─── Per-guild custom emoji cache ─────────────────────────────────────────────
const aiEmojiCache = new Map<string, Map<ExpressionKey, string>>();

// ─── Resolve the chibi image directory reliably in both dev and production ─────
// On Render: node runs dist/index.mjs inside artifacts/api-server/.
//   import.meta.url → file:///…/artifacts/api-server/dist/index.mjs
//   dirname → …/artifacts/api-server/dist/
//   one level up → …/artifacts/api-server/
//   + attached_assets/... → correct path
function resolveEmojiDir(): string {
  // 1. dist/chibi/ — images are copied here by build.mjs so they always travel with the bundle
  try {
    const bundleDir = dirname(fileURLToPath(import.meta.url));
    const distChibi = join(bundleDir, "chibi");
    if (existsSync(distChibi)) {
      console.log(`[Ai Emojis] Found images at: ${distChibi}`);
      return distChibi;
    }
    // 2. Legacy: attached_assets relative to bundle dir
    for (const rel of [".", "..", "../.."]) {
      const candidate = join(bundleDir, rel, "attached_assets", "generated_images", "ai_hoshino_resized");
      if (existsSync(candidate)) { console.log(`[Ai Emojis] Found images at: ${candidate}`); return candidate; }
    }
  } catch { /* import.meta.url unavailable */ }
  // 3. Fallback: relative to process.cwd()
  const cwd = process.cwd();
  for (const rel of [".", "..", "../..", "../../.."]) {
    const candidate = join(cwd, rel, "attached_assets", "generated_images", "ai_hoshino_resized");
    if (existsSync(candidate)) { console.log(`[Ai Emojis] Found images at (cwd): ${candidate}`); return candidate; }
  }
  const fallback = join(cwd, "attached_assets", "generated_images", "ai_hoshino_resized");
  console.warn(`[Ai Emojis] Image dir not found — cwd=${cwd}, bundleDir=unknown. Reactions only.`);
  return fallback;
}
const AI_EMOJI_DIR = resolveEmojiDir();

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initAiEmojis(): Promise<void> {
  // Keep old table for backward compat, add new ai_guild_emojis table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_guild_emojis (
      guild_id   TEXT NOT NULL,
      emotion    TEXT NOT NULL,
      emoji_id   TEXT NOT NULL,
      emoji_name TEXT NOT NULL,
      PRIMARY KEY (guild_id, emotion)
    )
  `);
  // Keep legacy teto table alive so existing data is not lost
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teto_guild_emojis (
      guild_id   TEXT NOT NULL,
      emotion    TEXT NOT NULL,
      emoji_id   TEXT NOT NULL,
      emoji_name TEXT NOT NULL,
      PRIMARY KEY (guild_id, emotion)
    )
  `);
}

// ─── Load previously uploaded emojis from DB into cache ──────────────────────
async function loadCachedAiEmojis(guildId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT emotion, emoji_id, emoji_name FROM ai_guild_emojis WHERE guild_id = $1`,
    [guildId]
  );
  if (rows.length === 0) return;
  const map = new Map<ExpressionKey, string>();
  for (const row of rows) {
    map.set(row.emotion as ExpressionKey, `<:${row.emoji_name}:${row.emoji_id}>`);
  }
  aiEmojiCache.set(guildId, map);
}

// ─── Upload emojis to guild (or load from DB if already done) ─────────────────
export async function uploadAiEmojis(guild: Guild): Promise<void> {
  const guildId = guild.id;

  const { rows: existing } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ai_guild_emojis WHERE guild_id = $1`,
    [guildId]
  );
  if (parseInt(existing[0].cnt) >= AI_EMOTIONS.length) {
    await loadCachedAiEmojis(guildId);
    return;
  }

  if (!existsSync(AI_EMOJI_DIR)) {
    // No images yet — silently use Unicode fallbacks, no warning spam
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers)) {
    console.warn(`[Ai Emojis] Missing ManageEmojisAndStickers in "${guild.name}"`);
    return;
  }

  console.log(`[Ai Emojis] Uploading Ai Hoshino emojis to "${guild.name}"...`);
  const map = new Map<ExpressionKey, string>();

  for (const emotion of AI_EMOTIONS) {
    const filePath = join(AI_EMOJI_DIR, `ai_${emotion}.png`);
    if (!existsSync(filePath)) {
      console.warn(`[Ai Emojis] File missing: ${filePath}`);
      continue;
    }

    const emojiName = `ai_${emotion}`;
    const alreadyInGuild = guild.emojis.cache.find((e) => e.name === emojiName);
    let emojiId: string;

    if (alreadyInGuild) {
      emojiId = alreadyInGuild.id;
    } else {
      try {
        const attachment = readFileSync(filePath);
        const emoji = await guild.emojis.create({
          attachment,
          name: emojiName,
          reason: "PIXEL — Ai Hoshino expression emojis",
        });
        emojiId = emoji.id;
        console.log(`[Ai Emojis] Uploaded ${emojiName} (${emojiId}) to "${guild.name}"`);
      } catch (err) {
        console.error(`[Ai Emojis] Failed to upload ${emojiName}:`, err);
        continue;
      }
    }

    await pool.query(
      `INSERT INTO ai_guild_emojis (guild_id, emotion, emoji_id, emoji_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, emotion) DO UPDATE SET emoji_id = $3, emoji_name = $4`,
      [guildId, emotion, emojiId, emojiName]
    );
    map.set(emotion, `<:${emojiName}:${emojiId}>`);
  }

  if (map.size > 0) {
    aiEmojiCache.set(guildId, map);
    console.log(`[Ai Emojis] ${map.size}/${AI_EMOTIONS.length} emojis ready in "${guild.name}"`);
  }
}

// ─── Pick emoji — custom guild emoji or Unicode fallback ──────────────────────
export function pickEmoji(emotion: ExpressionKey, guildId?: string): string {
  // 1. Try custom guild emoji for the specific guild
  if (guildId) {
    const guildEmojis = aiEmojiCache.get(guildId);
    if (guildEmojis?.has(emotion)) return guildEmojis.get(emotion)!;
  }

  // 2. DM context (no guildId) — custom emojis still work in DMs if the bot
  //    is in a guild that has them. Use the first cached guild's emoji.
  if (!guildId && aiEmojiCache.size > 0) {
    for (const guildEmojis of aiEmojiCache.values()) {
      if (guildEmojis.has(emotion)) return guildEmojis.get(emotion)!;
    }
  }

  // 3. Unicode fallback (no custom emojis uploaded yet)
  const opts = AI_HOSHINO_EMOJIS[emotion];
  return opts[Math.floor(Math.random() * opts.length)];
}

// ─── Get local expression image path (for embed thumbnail) ───────────────────
export function getExpressionImagePath(emotion: ExpressionKey): string | null {
  const filePath = join(AI_EMOJI_DIR, `ai_${emotion}.png`);
  const found = existsSync(filePath);
  if (!found) {
    console.warn(`[Ai Emojis] Image not found: ${filePath} (dir=${AI_EMOJI_DIR})`);
  }
  return found ? filePath : null;
}

// ─── Parse emotion tag injected by AI: [E:happy] → { emotion, clean text } ───
const EMOTION_TAG_RE = /^\[E:(happy|thinking|shocked|cool|sad|laugh|love|angry|sleepy|nervous|wink|embarrassed|smug|cry|excited|bored|confused|shy|proud|sparkle)\]\s*/;

const ANY_EMOTION_TAG_RE = /^\[E:[a-z_]+\]\s*/;

const EMOTION_ALIASES: Record<string, ExpressionKey> = {
  smile:    "happy",
  sad_face: "sad",
  joy:      "laugh",
  fear:     "nervous",
  blush:    "embarrassed",
  star:     "sparkle",
  heart:    "love",
  fire:     "excited",
  yawn:     "sleepy",
  shrug:    "confused",
};

export function parseEmotion(text: string): { emotion: ExpressionKey | null; clean: string } {
  const m = text.match(EMOTION_TAG_RE);
  if (m) return { emotion: m[1] as ExpressionKey, clean: text.slice(m[0].length) };

  const anyM = text.match(ANY_EMOTION_TAG_RE);
  if (anyM) {
    const raw = anyM[0].trim().replace(/^\[E:/, "").replace(/\]$/, "");
    const mapped: ExpressionKey = EMOTION_ALIASES[raw] ?? "happy";
    return { emotion: mapped, clean: text.slice(anyM[0].length) };
  }

  return { emotion: null, clean: text };
}
