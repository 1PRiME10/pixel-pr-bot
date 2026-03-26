import { isClaimed } from "../message-gate.js";
import { tryClaimGuildEvent } from "../message-dedup.js";
import {
  Client,
  Events,
  EmbedBuilder,
  TextChannel,
  GuildMember,
  PermissionFlagsBits,
  Message,
} from "discord.js";
import { pool } from "@workspace/db";

// ─── Per-guild welcome channel: guildId → channelId ──────────────────────────
const welcomeChannels = new Map<string, string>();
// ─── Per-guild welcome message override: guildId → custom text ───────────────
const welcomeMessages = new Map<string, string>();

export async function initWelcome(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS welcome_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message    TEXT
    )
  `);
  const { rows } = await pool.query(`SELECT guild_id, channel_id, message FROM welcome_config`);
  for (const row of rows) {
    welcomeChannels.set(row.guild_id, row.channel_id);
    if (row.message) welcomeMessages.set(row.guild_id, row.message);
  }
  console.log(`Loaded ${welcomeChannels.size} welcome channel(s) from DB`);
}

export function getWelcomeChannelId(guildId: string): string | undefined {
  return welcomeChannels.get(guildId);
}

export function getWelcomeMessage(guildId: string): string | undefined {
  return welcomeMessages.get(guildId);
}

export async function setWelcomeChannel(guildId: string, channelId: string): Promise<void> {
  welcomeChannels.set(guildId, channelId);
  await pool.query(
    `INSERT INTO welcome_config (guild_id, channel_id) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
    [guildId, channelId],
  );
}

export async function setWelcomeMsg(guildId: string, msg: string): Promise<void> {
  welcomeMessages.set(guildId, msg);
  await pool.query(
    `INSERT INTO welcome_config (guild_id, channel_id, message)
     VALUES ($1, COALESCE((SELECT channel_id FROM welcome_config WHERE guild_id = $1), ''), $2)
     ON CONFLICT (guild_id) DO UPDATE SET message = $2`,
    [guildId, msg],
  );
}

export async function clearWelcomeConfig(guildId: string): Promise<void> {
  welcomeChannels.delete(guildId);
  welcomeMessages.delete(guildId);
  await pool.query(`DELETE FROM welcome_config WHERE guild_id = $1`, [guildId]);
}

export async function sendWelcomeEmbed(channel: TextChannel, member: GuildMember, customMsg?: string) {
  const embed = new EmbedBuilder()
    .setColor(0x7289da)
    .setTitle("✨ Welcome to the server!")
    .setDescription(
      customMsg
        ? customMsg.replace("{user}", `${member}`).replace("{server}", member.guild.name)
        : `Hey ${member}, welcome to **${member.guild.name}**! 🎉\nWe're glad you're here — feel free to introduce yourself!`
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Member #${member.guild.memberCount}` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

// ─── In-process dedup: prevents double welcome within the same process ────────
// Key: "welcome:guildId:memberId" → timestamp of last send
const recentWelcomesSent = new Map<string, number>();
const WELCOME_DEDUP_WINDOW_MS = 30_000; // 30 seconds

export function registerWelcome(client: Client) {
  // ── GuildMemberAdd: send welcome embed ──────────────────────────────────────
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    const guildId = member.guild.id;
    const eventKey = `welcome:${guildId}:${member.id}`;

    // Layer 1: In-process dedup (fastest, no DB) — guards against event replay
    const lastSent = recentWelcomesSent.get(eventKey) ?? 0;
    if (Date.now() - lastSent < WELCOME_DEDUP_WINDOW_MS) {
      console.log(`[Welcome] Skipped (in-process dedup): ${eventKey}`);
      return;
    }

    // Layer 2: Cross-instance DB dedup — guards against multi-process scenarios
    const claimed = await tryClaimGuildEvent(eventKey);
    console.log(`[Welcome] GuildMemberAdd: ${eventKey} | DB claim: ${claimed}`);
    if (!claimed) return;

    // Mark as sent in-process immediately to prevent any race within this process
    recentWelcomesSent.set(eventKey, Date.now());

    const channelId = welcomeChannels.get(guildId);

    let targetChannel: TextChannel | null = null;

    if (channelId) {
      const ch = member.guild.channels.cache.get(channelId);
      if (ch instanceof TextChannel) targetChannel = ch;
    }

    // Fall back to the guild's system channel if no welcome channel is configured
    if (!targetChannel) {
      const sys = member.guild.systemChannel;
      if (sys instanceof TextChannel) targetChannel = sys;
    }

    if (!targetChannel) return;

    const customMsg = welcomeMessages.get(guildId);
    console.log(`[Welcome] Sending embed to ${targetChannel.name} for ${member.user.tag}`);
    await sendWelcomeEmbed(targetChannel, member, customMsg).catch(console.error);
  });

  // ── Commands ────────────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim();

    // !setwelcome [#channel]
    if (content === "!setwelcome" || content.startsWith("!setwelcome ")) {
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("❌ You need **Administrator** permission for this."); return;
      }
      const mentioned = message.mentions.channels.first() as TextChannel | undefined;
      const target = mentioned ?? (message.channel as TextChannel);
      const guildId = message.guild.id;

      welcomeChannels.set(guildId, target.id);
      await pool.query(
        `INSERT INTO welcome_config (guild_id, channel_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
        [guildId, target.id]
      );
      await message.reply(`✅ Welcome channel set to ${target}! New members will be greeted there.`);
    }

    // !setwelcomemsg <custom message> — use {user} and {server} as placeholders
    if (content.startsWith("!setwelcomemsg ")) {
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("❌ You need **Administrator** permission for this."); return;
      }
      const customMsg = content.slice("!setwelcomemsg ".length).trim();
      if (!customMsg) {
        await message.reply("Usage: `!setwelcomemsg <message>` — use `{user}` and `{server}` as placeholders."); return;
      }
      const guildId = message.guild.id;
      welcomeMessages.set(guildId, customMsg);
      await pool.query(
        `INSERT INTO welcome_config (guild_id, channel_id, message)
         VALUES ($1, COALESCE((SELECT channel_id FROM welcome_config WHERE guild_id = $1), ''), $2)
         ON CONFLICT (guild_id) DO UPDATE SET message = $2`,
        [guildId, customMsg]
      );
      await message.reply(`✅ Custom welcome message saved!\nPreview: ${customMsg.replace("{user}", `**${message.author.username}**`).replace("{server}", message.guild.name)}`);
    }

    // !removewelcome
    if (content === "!removewelcome") {
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("❌ You need **Administrator** permission for this."); return;
      }
      const guildId = message.guild.id;
      welcomeChannels.delete(guildId);
      welcomeMessages.delete(guildId);
      await pool.query(`DELETE FROM welcome_config WHERE guild_id = $1`, [guildId]);
      await message.reply("✅ Welcome channel removed. New members will no longer be greeted automatically.");
    }

    // !testwelcome — preview the welcome message
    if (content === "!testwelcome") {
      if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
        await message.reply("❌ You need **Administrator** permission for this."); return;
      }
      const guildId = message.guild.id;
      const channelId = welcomeChannels.get(guildId);
      if (!channelId) {
        await message.reply("❌ No welcome channel set. Use `!setwelcome #channel` first."); return;
      }
      const ch = message.guild.channels.cache.get(channelId);
      if (!(ch instanceof TextChannel)) {
        await message.reply("❌ Configured welcome channel not found. Try `!setwelcome #channel` again."); return;
      }
      const member = message.member as GuildMember;
      const customMsg = welcomeMessages.get(guildId);

      // Delete the command message so it doesn't clutter the welcome channel
      await message.delete().catch(() => {});

      // Send the embed (this IS the confirmation)
      await sendWelcomeEmbed(ch, member, customMsg);

      // If the command was typed in a DIFFERENT channel, send a brief ✅ there
      if (message.channelId !== channelId) {
        const note = await (message.channel as TextChannel)
          .send(`✅ Test welcome sent to ${ch}!`).catch(() => null);
        if (note) setTimeout(() => note.delete().catch(() => {}), 5_000);
      }
    }
  });
}
