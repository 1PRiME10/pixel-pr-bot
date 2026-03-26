import { isClaimed } from "../message-gate.js";
import {
  Client,
  Events,
  EmbedBuilder,
  TextChannel,
  AuditLogEvent,
  GuildMember,
  PermissionFlagsBits,
  Message,
} from "discord.js";
import { pool } from "@workspace/db";

// ─── Per-guild log channel: guildId → channelId ───────────────────────────────
export const serverLogChannels = new Map<string, string>();

// ─── DB init + load ───────────────────────────────────────────────────────────
export async function initServerLog(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_log_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  const { rows } = await pool.query(`SELECT guild_id, channel_id FROM server_log_config`);
  for (const row of rows) serverLogChannels.set(row.guild_id, row.channel_id);
  console.log(`Loaded ${rows.length} server log channel(s) from DB`);
}

async function saveServerLog(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO server_log_config (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
    [guildId, channelId]
  );
}

async function deleteServerLog(guildId: string): Promise<void> {
  await pool.query(`DELETE FROM server_log_config WHERE guild_id = $1`, [guildId]);
}

async function getLogChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  const channelId = serverLogChannels.get(guildId);
  if (!channelId) return null;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const ch = guild.channels.cache.get(channelId);
  return ch instanceof TextChannel ? ch : null;
}

async function log(client: Client, guildId: string, embed: EmbedBuilder) {
  const ch = await getLogChannel(client, guildId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

export function registerServerLog(client: Client) {

  // ── !setserverlog / !removeserverlog ──────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim();

    if (content === "!setserverlog" || content.startsWith("!setserverlog ")) {
      const mentioned = message.mentions.channels.first() as TextChannel | undefined;
      const target = mentioned ?? (message.channel as TextChannel);
      serverLogChannels.set(message.guild.id, target.id);
      await saveServerLog(message.guild.id, target.id);
      await message.reply(
        `✅ Server log channel set to ${target}.\n` +
        `I'll log: message edits/deletes, member join/leave, role & nickname changes, and more.\n` +
        `Use \`!removeserverlog\` to stop logging.`
      );
    }

    if (content === "!removeserverlog") {
      if (serverLogChannels.has(message.guild!.id)) {
        serverLogChannels.delete(message.guild!.id);
        await deleteServerLog(message.guild!.id);
        await message.reply("✅ Server log channel removed.");
      } else {
        await message.reply("No server log channel was set.");
      }
    }
  });

  // ── Message deleted ───────────────────────────────────────────────────────
  client.on(Events.MessageDelete, async (message) => {
    if (!message.guild || message.author?.bot) return;
    const embed = new EmbedBuilder()
      .setTitle("🗑️ Message Deleted")
      .setColor(0xff4444)
      .addFields(
        { name: "Author", value: message.author ? `${message.author.tag} (<@${message.author.id}>)` : "Unknown", inline: true },
        { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        { name: "Content", value: message.content?.slice(0, 1000) || "*(empty or unknown)*" },
      )
      .setTimestamp();
    await log(client, message.guild.id, embed);
  });

  // ── Message edited ────────────────────────────────────────────────────────
  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    const embed = new EmbedBuilder()
      .setTitle("✏️ Message Edited")
      .setColor(0xffa500)
      .setURL(newMsg.url)
      .addFields(
        { name: "Author", value: `${newMsg.author?.tag} (<@${newMsg.author?.id}>)`, inline: true },
        { name: "Channel", value: `<#${newMsg.channelId}>`, inline: true },
        { name: "Before", value: oldMsg.content?.slice(0, 500) || "*(unknown)*" },
        { name: "After", value: newMsg.content?.slice(0, 500) || "*(empty)*" },
      )
      .setTimestamp();
    await log(client, newMsg.guild.id, embed);
  });

  // ── Member joined ─────────────────────────────────────────────────────────
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
    const embed = new EmbedBuilder()
      .setTitle("📥 Member Joined")
      .setColor(0x57f287)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${member.user.tag} (<@${member.id}>)`, inline: true },
        { name: "Account Age", value: `${ageDays} days`, inline: true },
        { name: "Member Count", value: `${member.guild.memberCount}`, inline: true },
        { name: "Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      )
      .setFooter({ text: `ID: ${member.id}` })
      .setTimestamp();
    await log(client, member.guild.id, embed);
  });

  // ── Member left ───────────────────────────────────────────────────────────
  client.on(Events.GuildMemberRemove, async (member) => {
    const roles = member.roles?.cache
      .filter((r) => r.id !== member.guild.id)
      .map((r) => r.name).join(", ") || "None";
    const embed = new EmbedBuilder()
      .setTitle("📤 Member Left")
      .setColor(0xed4245)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "User", value: `${member.user.tag} (<@${member.id}>)`, inline: true },
        { name: "Roles", value: roles.slice(0, 200) },
      )
      .setFooter({ text: `ID: ${member.id}` })
      .setTimestamp();
    await log(client, member.guild.id, embed);
  });

  // ── Nickname changed ──────────────────────────────────────────────────────
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (oldMember.nickname === newMember.nickname) return;
    const embed = new EmbedBuilder()
      .setTitle("📝 Nickname Changed")
      .setColor(0x5865f2)
      .addFields(
        { name: "User", value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
        { name: "Before", value: oldMember.nickname ?? "*(none)*", inline: true },
        { name: "After", value: newMember.nickname ?? "*(none)*", inline: true },
      )
      .setTimestamp();
    await log(client, newMember.guild.id, embed);
  });

  // ── Role added/removed from member ────────────────────────────────────────
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
    if (added.size === 0 && removed.size === 0) return;

    const embed = new EmbedBuilder()
      .setTitle("🎭 Roles Updated")
      .setColor(0x9c59b6)
      .addFields(
        { name: "User", value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: true },
        ...(added.size > 0 ? [{ name: "✅ Added", value: added.map((r) => r.name).join(", "), inline: true }] : []),
        ...(removed.size > 0 ? [{ name: "❌ Removed", value: removed.map((r) => r.name).join(", "), inline: true }] : []),
      )
      .setTimestamp();
    await log(client, newMember.guild.id, embed);
  });

  // ── Webhook created ───────────────────────────────────────────────────────
  client.on(Events.WebhooksUpdate, async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const embed = new EmbedBuilder()
      .setTitle("🔗 Webhook Created/Modified")
      .setColor(0xff6b35)
      .setDescription(
        `A webhook was created or modified in <#${channel.id}>.\n` +
        `⚠️ If you didn't do this, investigate immediately!`
      )
      .setTimestamp();
    await log(client, channel.guild.id, embed);
  });
}
