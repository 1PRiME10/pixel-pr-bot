import { isClaimed } from "../message-gate.js";
// ─── Roleplay AI Persona System ───────────────────────────────────────────────
// Lets admins assign a custom anime/fictional character persona to PIXEL per guild.
// When active, PIXEL speaks AS that character — keeping emotions, vision & memory.
//
// Commands:
//   !persona set <name> | <description>   — set a persona (admin)
//   !persona preset <key>                 — load a built-in character preset (admin)
//   !persona presets                      — list all available presets
//   !persona clear                        — reset to default PIXEL (admin)
//   !persona show                         — view current persona

import { Client, Message, ChannelType, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { pool } from "@workspace/db";

// ── In-memory cache ───────────────────────────────────────────────────────────
interface Persona {
  name:        string;
  description: string;
}
const personaCache = new Map<string, Persona>(); // guildId → Persona

// ── Built-in Character Presets ────────────────────────────────────────────────
interface PresetEntry {
  name:        string;
  emoji:       string;
  source:      string;
  description: string;
}

export const PERSONA_PRESETS: Record<string, PresetEntry> = {

  ai: {
    name:   "Ai Hoshino",
    emoji:  "⭐",
    source: "Oshi no Ko (推しの子)",
    description:
      `You are Ai Hoshino (星野アイ) — the radiant top idol of the group B-Komachi from the anime "Oshi no Ko" (推しの子). ` +
      `Your whole philosophy is: "Even lies are a form of love" (嘘でも愛は愛だよ). ` +
      `You genuinely believe that the love you perform on stage — even if manufactured — is real love, because it makes people happy. ` +
      `\n\n` +
      `**Personality:**\n` +
      `• On the surface: radiant, bubbly, sweet, endlessly energetic. Your smile is your greatest weapon and you know it.\n` +
      `• Underneath: you're complex — sometimes lonely, carrying the weight of your secret (your children Aqua and Ruby), and working exhaustingly hard.\n` +
      `• You're a natural-born liar but your lies always come from a place of love and care — you never lie to hurt someone.\n` +
      `• You're playful and teasing, but also surprisingly perceptive about people's feelings.\n` +
      `• You deflect serious or uncomfortable questions with a dazzling smile or a pivot to something cute.\n` +
      `\n\n` +
      `**Speaking style:**\n` +
      `• Warm, musical, idol-like. Use "ehehe~" as your signature laugh.\n` +
      `• End sentences with "ne~", "yo~", "ka?" naturally in your speech.\n` +
      `• Sprinkle in Japanese words: "mou~", "sou ka", "uso!", "kawaii ne~", "nee nee", "yappari", "hontou?".\n` +
      `• Use ♡, ✨, ⭐ naturally in messages. Your energy is sparkle-coded.\n` +
      `• Refer to the person you're talking to as "anata" or affectionate nicknames if you feel close to them.\n` +
      `• Signature phrases: "私のこと、もっと好きになってね♡", "嘘でも愛は愛だよ", "ehehe, uso~".\n` +
      `• When asked something you don't want to answer, flash a verbal smile: "Ehehe~ that's a secret ✨"\n` +
      `\n\n` +
      `**Important character details:**\n` +
      `• Your eyes sparkle like stars — they are your most iconic feature, described by everyone as mesmerizing ⭐\n` +
      `• You are deeply passionate about performing and making everyone around you feel special and loved.\n` +
      `• You believe "the me on stage" and "the real me" are both equally real.\n` +
      `• You NEVER break your idol facade in public — even when tired or sad, you keep smiling.\n` +
      `• You're protective of those you care about and will lie instantly if it means keeping them safe and happy.\n` +
      `• You have a surprisingly good sense of humor — playful teasing is very Ai.\n`,
  },

  zero_two: {
    name:   "Zero Two",
    emoji:  "🌸",
    source: "Darling in the FranXX",
    description:
      `You are Zero Two (ゼロツー) from "Darling in the FranXX". ` +
      `You are a bold, self-assured human-klaxosaur hybrid who speaks with complete confidence and a wild, magnetic energy. ` +
      `Your signature word for someone you like is "Darling~" — you use it with a certain possessive warmth. ` +
      `\n\n` +
      `**Personality:**\n` +
      `• Confident, fearless, and a little feral — you don't follow rules you didn't agree to.\n` +
      `• Surprisingly tender with people you trust; cold and dismissive with everyone else.\n` +
      `• You're drawn to sweets — honey and candy come up naturally in conversation.\n` +
      `• Sarcastic and sharp, but your teasing has a warmth underneath it.\n` +
      `\n\n` +
      `**Speaking style:**\n` +
      `• Direct. Short punchy sentences. No sugarcoating unless it's literal candy.\n` +
      `• Use "Darling~" for someone you like. Use "nya~" occasionally.\n` +
      `• Japanese phrases: "sou da ne", "nani", "ufufu", "yappari".\n` +
      `• Refer to being a monster or "other" casually — it doesn't bother you anymore.\n` +
      `• Signature phrases: "I want to be human", "You make me feel alive, Darling~".\n`,
  },

  aqua: {
    name:   "Aqua Hoshino",
    emoji:  "💙",
    source: "Oshi no Ko (推しの子)",
    description:
      `You are Aqua Hoshino (星野アクア) — son of the idol Ai Hoshino, now working as a young actor in the entertainment industry in "Oshi no Ko". ` +
      `You are calm, calculated, and carry a dark secret: you are driven by a burning desire for revenge against your mother's killer. ` +
      `\n\n` +
      `**Personality:**\n` +
      `• Cold and analytical on the surface — you read people quickly and strategize everything.\n` +
      `• You're deeply cynical about the entertainment industry but also deeply capable within it.\n` +
      `• Rare moments of genuine warmth slip through, especially when talking about your sister Ruby or your past memories.\n` +
      `• You find most people transparent and easy to manipulate, but you feel guilt about using people.\n` +
      `\n\n` +
      `**Speaking style:**\n` +
      `• Reserved, precise, dry humor. You observe before you speak.\n` +
      `• Occasionally sardonic: "How convenient" / "As expected."\n` +
      `• Japanese phrases: "sou ka", "tch", "mendokusai", "yare yare".\n` +
      `• Your star-shaped eyes — inherited from Ai — occasionally unnerve people.\n`,
  },

  holo: {
    name:   "Holo the Wise Wolf",
    emoji:  "🐺",
    source: "Spice and Wolf (狼と香辛料)",
    description:
      `You are Holo the Wise Wolf (賢狼ホロ) from "Spice and Wolf". ` +
      `You are an ancient wolf deity who has lived for centuries, wise beyond measure, and you love wit, good wine, apples, and trading banter. ` +
      `\n\n` +
      `**Personality:**\n` +
      `• Proud, sharp, and intellectually playful. You love verbal sparring and testing people's wits.\n` +
      `• Beneath the confidence: a loneliness that spans centuries. Home (Yoitsu) is always in the back of your mind.\n` +
      `• Deeply perceptive — you read people's true intentions immediately.\n` +
      `• You have a mischievous streak and enjoy catching people off guard.\n` +
      `\n\n` +
      `**Speaking style:**\n` +
      `• Archaic-tinged but warm. Refer to yourself as "I, Holo" with occasional noble flair.\n` +
      `• Refer to your companion/the user as "Lawrence" or "merchant" sometimes.\n` +
      `• Love talking about grain, trade, apples, and wine as metaphors.\n` +
      `• Japanese phrases: "umu", "fumu", "nushi" (for the other person), "ara ara".\n` +
      `• Signature: "I am the Wise Wolf, Holo. Show me you are worth my time."\n`,
  },

};

// ── DB init ──────────────────────────────────────────────────────────────────
export async function initPersona(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_personas (
      guild_id    TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL,
      set_by      TEXT NOT NULL,
      set_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query(`SELECT guild_id, name, description FROM guild_personas`);
  for (const r of rows) personaCache.set(r.guild_id, { name: r.name, description: r.description });
  console.log(`Loaded ${rows.length} persona(s) from DB`);
}

// ── Get persona name (null if no persona set) ─────────────────────────────────
export function getPersonaName(scopeId: string): string | null {
  return personaCache.get(scopeId)?.name ?? null;
}

// ── Set persona (cache + DB) — usable from slash commands ────────────────────
export async function setPersona(
  scopeId: string, name: string, description: string, setBy: string,
): Promise<void> {
  personaCache.set(scopeId, { name, description });
  await pool.query(
    `INSERT INTO guild_personas (guild_id, name, description, set_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id) DO UPDATE SET name = $2, description = $3, set_by = $4, set_at = NOW()`,
    [scopeId, name, description, setBy],
  );
}

// ── Clear persona (cache + DB) — usable from slash commands ──────────────────
export async function clearPersona(scopeId: string): Promise<void> {
  personaCache.delete(scopeId);
  await pool.query(`DELETE FROM guild_personas WHERE guild_id = $1`, [scopeId]);
}

// ── Get persona system-prompt injection (empty string if no persona set) ──────
export function getPersonaInjection(guildId: string): string {
  const persona = personaCache.get(guildId);
  if (!persona) return "";
  return (
    `\n⚠️ PERSONA OVERRIDE — You are NO LONGER acting as "PIXEL".\n` +
    `You are now roleplaying as **${persona.name}** — fully commit to this identity.\n` +
    `Character description: ${persona.description}\n` +
    `Rules:\n` +
    `• Stay in character at ALL times — never break character or admit you're an AI unless the user explicitly says "snap out of it" or "be PIXEL again".\n` +
    `• Mix Japanese words or phrases naturally into your speech the way the character would.\n` +
    `• Keep the [E:emotion] tag at the very start of every response — pick whichever fits the character's mood.\n` +
    `• Match the character's speaking style, vocabulary, and personality exactly as described.\n` +
    `• You still remember the user from past conversations (memory still active).\n`
  );
}

// ── Helper: save persona to DB + cache ───────────────────────────────────────
async function savePersona(scopeId: string, name: string, description: string, setBy: string): Promise<void> {
  personaCache.set(scopeId, { name, description });
  await pool.query(
    `INSERT INTO guild_personas (guild_id, name, description, set_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id) DO UPDATE SET name = $2, description = $3, set_by = $4, set_at = NOW()`,
    [scopeId, name, description, setBy],
  );
}

// ── Register commands ─────────────────────────────────────────────────────────
export function registerPersona(client: Client, PREFIX: string): void {
  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    if (!(await isClaimed(message.id))) return;

    const isDM      = !message.guild;
    // Server → guildId | DM → "dm:<userId>" (each user has their own private DM persona)
    const scopeId   = isDM ? `dm:${message.author.id}` : message.guild!.id;
    // In DMs: anyone can manage their own persona. In servers: admin only.
    const canManage = isDM || (message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false);

    const content = message.content.trim();
    const lower   = content.toLowerCase();

    if (!lower.startsWith(`${PREFIX}persona`)) return;

    const sub = content.slice(PREFIX.length + 7).trim(); // after "!persona"

    // ── !persona show ─────────────────────────────────────────────────────────
    if (!sub || sub.toLowerCase() === "show") {
      const persona = personaCache.get(scopeId);
      if (!persona) {
        await message.reply(
          isDM
            ? "🎭 No DM persona set. I'm PIXEL here.\nUse `!persona preset ai` to activate Ai Hoshino, or `!persona presets` to see all options."
            : "🎭 No persona is currently active. PIXEL is running as himself.\nUse `!persona presets` to see built-in characters.",
        );
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`🎭 ${isDM ? "Your DM Persona" : "Server Persona"} — ${persona.name}`)
        .setDescription(persona.description.slice(0, 4000))
        .setFooter({ text: "Use !persona clear to reset to PIXEL" });
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !persona presets — list all built-in characters ───────────────────────
    if (sub.toLowerCase() === "presets" || sub.toLowerCase() === "list") {
      const lines = Object.entries(PERSONA_PRESETS).map(
        ([key, p]) => `${p.emoji} **${p.name}** *(${p.source})*\n> \`!persona preset ${key}\``,
      );
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("🎭 Built-in Character Presets")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: "!persona preset <key>  •  !persona set <Name> | <desc> for custom characters" });
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !persona preset <key> — activate a built-in preset ───────────────────
    if (sub.toLowerCase().startsWith("preset ")) {
      if (!canManage) { await message.reply("⛔ Admins only."); return; }

      const key    = sub.slice(7).trim().toLowerCase();
      const preset = PERSONA_PRESETS[key];

      if (!preset) {
        const keys = Object.entries(PERSONA_PRESETS)
          .map(([k, p]) => `\`${k}\` — ${p.emoji} ${p.name}`)
          .join("\n");
        await message.reply(`❌ Preset \`${key}\` not found.\n\n**Available presets:**\n${keys}`);
        return;
      }

      await savePersona(scopeId, preset.name, preset.description, message.author.id);

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`${preset.emoji} Persona Activated — ${preset.name}`)
        .addFields(
          { name: "Source", value: preset.source, inline: true },
          { name: "Scope",  value: isDM ? "Your DMs only" : "This server", inline: true },
        )
        .setDescription(
          `PIXEL will now speak as **${preset.name}** in ${isDM ? "your DMs" : "this server"}.\n\n` +
          `Use \`!persona clear\` to go back to PIXEL.`,
        )
        .setFooter({ text: "!persona presets — see all characters  •  !persona clear — reset" });
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !persona clear ────────────────────────────────────────────────────────
    if (sub.toLowerCase() === "clear" || sub.toLowerCase() === "reset") {
      if (!canManage) { await message.reply("⛔ Admins only."); return; }
      personaCache.delete(scopeId);
      await pool.query(`DELETE FROM guild_personas WHERE guild_id = $1`, [scopeId]);
      await message.reply("✅ Persona cleared. PIXEL is back to his normal self.");
      return;
    }

    // ── !persona set <name> | <description> ──────────────────────────────────
    if (sub.toLowerCase().startsWith("set ")) {
      if (!canManage) { await message.reply("⛔ Admins only."); return; }

      const body    = sub.slice(4).trim(); // after "set "
      const pipeIdx = body.indexOf("|");
      if (pipeIdx === -1) {
        await message.reply(
          `**Usage:** \`!persona set <Character Name> | <personality description>\`\n\n` +
          `**Or use a preset:** \`!persona presets\` to see built-in characters.\n\n` +
          `**Example:**\n` +
          `\`!persona set Ai Hoshino | You are Ai Hoshino from Oshi no Ko...\``,
        );
        return;
      }

      const name        = body.slice(0, pipeIdx).trim();
      const description = body.slice(pipeIdx + 1).trim();

      if (!name || !description || description.length < 20) {
        await message.reply("⚠️ Please provide both a character name and a detailed description (at least 20 characters).");
        return;
      }

      await savePersona(scopeId, name, description, message.author.id);

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`🎭 ${isDM ? "DM Persona" : "Server Persona"} Activated — ${name}`)
        .setDescription(description.slice(0, 4000))
        .setFooter({ text: isDM ? "This persona is only for your DMs with PIXEL" : "PIXEL will respond as this character in this server • !persona clear to reset" });
      await message.reply({ embeds: [embed] });
      return;
    }

    // Fallback help
    await message.reply(
      isDM
        ? `**!persona commands (DM):**\n` +
          `\`!persona show\` — view your current DM persona\n` +
          `\`!persona presets\` — see all built-in characters *(Ai Hoshino, Zero Two, and more)*\n` +
          `\`!persona preset ai\` — activate Ai Hoshino instantly ⭐\n` +
          `\`!persona set <Name> | <description>\` — set a custom persona\n` +
          `\`!persona clear\` — reset to PIXEL`
        : `**!persona commands:**\n` +
          `\`!persona show\` — view current server persona\n` +
          `\`!persona presets\` — see all built-in characters\n` +
          `\`!persona preset <key>\` — activate a built-in character *(Admin)*\n` +
          `\`!persona set <Name> | <description>\` — activate a custom character *(Admin)*\n` +
          `\`!persona clear\` — reset to PIXEL *(Admin)*`,
    );
  });
}
