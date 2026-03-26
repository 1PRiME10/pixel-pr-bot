// ─── Kasane Teto + Ai Hoshino Expression Emojis ───────────────────────────────
// Uploads character expression PNGs as custom emojis to each guild and caches
// the emoji IDs in PostgreSQL so they survive bot restarts.
//
// Exported utilities used by the AI chat reply handler:
//   pickEmoji(emotion, guildId?, personaName?) — returns custom emoji or Unicode fallback
//   parseEmotion(text)                          — strips [E:emotion] tag injected by the AI

import { Guild, PermissionFlagsBits } from "discord.js";
import { pool } from "@workspace/db";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────
export type ExpressionKey = "happy" | "thinking" | "shocked" | "cool" | "sad" | "laugh";

const TETO_EMOTIONS: ExpressionKey[] = ["happy", "thinking", "shocked", "cool", "sad", "laugh"];

// ─── Unicode fallbacks — Teto (default) ───────────────────────────────────────
const EXPRESSION_EMOJIS: Record<ExpressionKey, string[]> = {
  happy:    ["😊", "😄", "🥰", "✨", "😁"],
  thinking: ["🤔", "🧐", "💭", "🤨", "🫠"],
  shocked:  ["😱", "😲", "🤯", "😳", "👀"],
  cool:     ["😎", "🔥", "💅", "🫡", "⚡"],
  sad:      ["😢", "🥺", "😔", "💔", "😞"],
  laugh:    ["😂", "💀", "🤣", "😭", "😹"],
};

// ─── Unicode fallbacks — Ai Hoshino (star idol themed) ───────────────────────
const AI_HOSHINO_EMOJIS: Record<ExpressionKey, string[]> = {
  happy:    ["⭐", "✨", "🌟", "💫", "🥰"],
  thinking: ["🤔", "💭", "🫠", "🌸", "🫧"],
  shocked:  ["😲", "🤯", "💥", "🌠", "😳"],
  cool:     ["🌟", "💅", "👑", "💎", "✨"],
  sad:      ["🥺", "💔", "😔", "🌧️", "💧"],
  laugh:    ["😂", "🌸", "💫", "😭", "✨"],
};

// ─── Per-guild custom emoji cache ─────────────────────────────────────────────
const tetoEmojiCache = new Map<string, Map<ExpressionKey, string>>();

// ─── Resolve workspace root (differs between dev and production) ──────────────
function getWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "attached_assets"))) return cwd;
  const up2 = join(cwd, "../..");
  if (existsSync(join(up2, "attached_assets"))) return up2;
  return cwd;
}
const TETO_EMOJI_DIR = join(getWorkspaceRoot(), "attached_assets", "generated_images", "teto_resized");

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initTetoEmojis(): Promise<void> {
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
async function loadCachedTetoEmojis(guildId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT emotion, emoji_id, emoji_name FROM teto_guild_emojis WHERE guild_id = $1`,
    [guildId]
  );
  if (rows.length === 0) return;
  const map = new Map<ExpressionKey, string>();
  for (const row of rows) {
    map.set(row.emotion as ExpressionKey, `<:${row.emoji_name}:${row.emoji_id}>`);
  }
  tetoEmojiCache.set(guildId, map);
}

// ─── Upload emojis to guild (or load from DB if already done) ─────────────────
export async function uploadTetoEmojis(guild: Guild): Promise<void> {
  const guildId = guild.id;

  const { rows: existing } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM teto_guild_emojis WHERE guild_id = $1`,
    [guildId]
  );
  if (parseInt(existing[0].cnt) >= TETO_EMOTIONS.length) {
    await loadCachedTetoEmojis(guildId);
    return;
  }

  if (!existsSync(TETO_EMOJI_DIR)) {
    console.warn(`[Teto Emojis] Directory not found: ${TETO_EMOJI_DIR}`);
    return;
  }

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers)) {
    console.warn(`[Teto Emojis] Missing ManageEmojisAndStickers in "${guild.name}"`);
    return;
  }

  console.log(`[Teto Emojis] Uploading Teto emojis to "${guild.name}"...`);
  const map = new Map<ExpressionKey, string>();

  for (const emotion of TETO_EMOTIONS) {
    const filePath = join(TETO_EMOJI_DIR, `teto_${emotion}.png`);
    if (!existsSync(filePath)) {
      console.warn(`[Teto Emojis] File missing: ${filePath}`);
      continue;
    }

    const emojiName = `teto_${emotion}`;
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
          reason: "PIXEL — Teto expression emojis",
        });
        emojiId = emoji.id;
        console.log(`[Teto Emojis] Uploaded ${emojiName} (${emojiId}) to "${guild.name}"`);
      } catch (err) {
        console.error(`[Teto Emojis] Failed to upload ${emojiName}:`, err);
        continue;
      }
    }

    await pool.query(
      `INSERT INTO teto_guild_emojis (guild_id, emotion, emoji_id, emoji_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, emotion) DO UPDATE SET emoji_id = $3, emoji_name = $4`,
      [guildId, emotion, emojiId, emojiName]
    );
    map.set(emotion, `<:${emojiName}:${emojiId}>`);
  }

  if (map.size > 0) {
    tetoEmojiCache.set(guildId, map);
    console.log(`[Teto Emojis] ${map.size}/6 emojis ready in "${guild.name}"`);
  }
}

// ─── Detect if a persona name belongs to Ai Hoshino ──────────────────────────
function isAiHoshino(personaName?: string | null): boolean {
  if (!personaName) return false;
  const n = personaName.toLowerCase();
  return n.includes("ai hoshino") || n.includes("アイ") || n === "ai" || n.includes("星野アイ");
}

// ─── Pick emoji — custom guild emoji or Unicode fallback ──────────────────────
// personaName: pass the current active persona name to get character-matching emojis
export function pickEmoji(emotion: ExpressionKey, guildId?: string, personaName?: string | null): string {
  // 1. Try custom guild emoji (Teto PNGs uploaded to Discord)
  if (guildId) {
    const guildEmojis = tetoEmojiCache.get(guildId);
    if (guildEmojis?.has(emotion)) return guildEmojis.get(emotion)!;
  }
  // 2. Choose fallback set based on active persona
  const emojiSet = isAiHoshino(personaName) ? AI_HOSHINO_EMOJIS : EXPRESSION_EMOJIS;
  const opts = emojiSet[emotion];
  return opts[Math.floor(Math.random() * opts.length)];
}

// ─── Parse emotion tag injected by AI: [E:happy] → { emotion, clean text } ───
const EMOTION_TAG_RE = /^\[E:(happy|thinking|shocked|cool|sad|laugh)\]\s*/;

export function parseEmotion(text: string): { emotion: ExpressionKey | null; clean: string } {
  const m = text.match(EMOTION_TAG_RE);
  if (!m) return { emotion: null, clean: text };
  return { emotion: m[1] as ExpressionKey, clean: text.slice(m[0].length) };
}
