import { isClaimed } from "../message-gate.js";
import {
  Client,
  Events,
  Message,
  PermissionFlagsBits,
  EmbedBuilder,
  TextChannel,
  GuildMember,
} from "discord.js";
import { pool } from "@workspace/db";

// ─── Shared warnings table (also used by auto-security and profanity-filter) ──
// source: 'moderation' | 'security' | 'profanity'
export async function initWarningsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_warnings (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      reason     TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'moderation',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_warnings_lookup
      ON user_warnings (guild_id, user_id, source)
  `);
}

// ─── Warnings (exported so other modules can use them) ────────────────────────
const warnings = new Map<string, Map<string, string[]>>();

// ─── DB init: load existing moderation warnings into memory ───────────────────
export async function initModeration(): Promise<void> {
  await initWarningsTable();
  const { rows } = await pool.query<{ guild_id: string; user_id: string; reason: string }>(
    `SELECT guild_id, user_id, reason FROM user_warnings WHERE source = 'moderation' ORDER BY id`
  );
  for (const row of rows) {
    if (!warnings.has(row.guild_id)) warnings.set(row.guild_id, new Map());
    const guildWarns = warnings.get(row.guild_id)!;
    const list = guildWarns.get(row.user_id) ?? [];
    list.push(row.reason);
    guildWarns.set(row.user_id, list);
  }
  console.log(`[Moderation] Loaded ${rows.length} warning(s) from DB`);
}

export function getWarnings(guildId: string, userId: string): string[] {
  return warnings.get(guildId)?.get(userId) ?? [];
}

export async function addWarningAndCheck(
  guildId: string,
  userId: string,
  reason: string,
  member: GuildMember,
  notifyChannel?: TextChannel
): Promise<void> {
  if (!warnings.has(guildId)) warnings.set(guildId, new Map());
  const guildWarns = warnings.get(guildId)!;
  const list = guildWarns.get(userId) ?? [];
  list.push(reason);
  guildWarns.set(userId, list);
  const count = list.length;

  // Persist to DB
  try {
    await pool.query(
      `INSERT INTO user_warnings (guild_id, user_id, reason, source) VALUES ($1, $2, $3, 'moderation')`,
      [guildId, userId, reason]
    );
  } catch (err) {
    console.error("[Moderation] Failed to persist warning to DB:", err);
  }

  // Auto-kick at 3 warnings
  if (count === 3) {
    try {
      await member.send(
        `⚠️ You have reached **3 warnings** in **${member.guild.name}** and have been automatically kicked.\nReason for latest warning: ${reason}`
      ).catch(() => {});
      await member.kick("Auto-moderation: 3 warnings threshold");
      await notifyChannel?.send(
        `🦶 ${member.user.tag} was **auto-kicked** after reaching 3 warnings.`
      ).catch(() => {});
    } catch {}
  }

  // Auto-ban at 5 warnings
  if (count >= 5) {
    try {
      await member.send(
        `🔨 You have reached **5 warnings** in **${member.guild.name}** and have been automatically banned.`
      ).catch(() => {});
      await member.ban({ reason: "Auto-moderation: 5 warnings threshold" });
      await notifyChannel?.send(
        `🔨 ${member.user.tag} was **auto-banned** after reaching 5 warnings.`
      ).catch(() => {});
    } catch {}
  }
}

export function clearWarnings(guildId: string, userId: string) {
  warnings.get(guildId)?.delete(userId);
  pool.query(
    `DELETE FROM user_warnings WHERE guild_id = $1 AND user_id = $2 AND source = 'moderation'`,
    [guildId, userId]
  ).catch((err) => console.error("[Moderation] Failed to clear warnings from DB:", err));
}

function hasAdminPerm(message: Message): boolean {
  return !!message.member?.permissions.has(PermissionFlagsBits.Administrator);
}

function hasPerm(message: Message, perm: bigint): boolean {
  return !!message.member?.permissions.has(perm);
}

export function registerModeration(client: Client) {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;

    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim();
    if (!content.startsWith("!")) return;

    const args = content.slice(1).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    // ── !kick @user [reason] ──────────────────────────────────────────────────
    if (command === "kick") {
      if (!hasPerm(message, PermissionFlagsBits.KickMembers))
        return void message.reply("❌ You need **Kick Members** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!kick @user [reason]`");
      if (!target.kickable) return void message.reply("❌ I can't kick that member.");
      const reason = args.slice(1).join(" ") || "No reason provided";
      await target.kick(reason).catch(() => null);
      await message.reply(`✅ **${target.user.tag}** has been kicked.\nReason: ${reason}`);
    }

    // ── !ban @user [reason] ───────────────────────────────────────────────────
    if (command === "ban") {
      if (!hasPerm(message, PermissionFlagsBits.BanMembers))
        return void message.reply("❌ You need **Ban Members** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!ban @user [reason]`");
      if (!target.bannable) return void message.reply("❌ I can't ban that member.");
      const reason = args.slice(1).join(" ") || "No reason provided";
      await target.ban({ reason, deleteMessageSeconds: 86400 }).catch(() => null);
      await message.reply(`🔨 **${target.user.tag}** has been banned.\nReason: ${reason}`);
    }

    // ── !unban <userId> ───────────────────────────────────────────────────────
    if (command === "unban") {
      if (!hasPerm(message, PermissionFlagsBits.BanMembers))
        return void message.reply("❌ You need **Ban Members** permission.");
      const userId = args[0];
      if (!userId) return void message.reply("Usage: `!unban <userId>`");
      try {
        await message.guild.members.unban(userId);
        await message.reply(`✅ User \`${userId}\` has been unbanned.`);
      } catch {
        await message.reply("❌ Could not unban — check the user ID.");
      }
    }

    // ── !mute @user [minutes] [reason] ────────────────────────────────────────
    if (command === "mute") {
      if (!hasPerm(message, PermissionFlagsBits.ModerateMembers))
        return void message.reply("❌ You need **Moderate Members** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!mute @user [minutes] [reason]`");
      const minutes = parseInt(args[1] ?? "10", 10) || 10;
      const reason = args.slice(2).join(" ") || "No reason provided";
      try {
        await target.timeout(Math.min(minutes, 40320) * 60 * 1000, reason);
        await message.reply(`🔇 **${target.user.tag}** muted for **${minutes} min**.\nReason: ${reason}`);
      } catch { await message.reply("❌ Couldn't mute that member."); }
    }

    // ── !unmute @user ─────────────────────────────────────────────────────────
    if (command === "unmute") {
      if (!hasPerm(message, PermissionFlagsBits.ModerateMembers))
        return void message.reply("❌ You need **Moderate Members** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!unmute @user`");
      try {
        await target.timeout(null);
        await message.reply(`🔊 **${target.user.tag}** has been unmuted.`);
      } catch { await message.reply("❌ Couldn't unmute."); }
    }

    // ── !warn @user [reason] ──────────────────────────────────────────────────
    if (command === "warn") {
      if (!hasPerm(message, PermissionFlagsBits.ModerateMembers))
        return void message.reply("❌ You need **Moderate Members** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!warn @user [reason]`");
      const reason = args.slice(1).join(" ") || "No reason provided";
      await addWarningAndCheck(
        message.guild.id, target.id, reason, target,
        message.channel as TextChannel
      );
      const count = getWarnings(message.guild.id, target.id).length;
      await message.reply(
        `⚠️ **${target.user.tag}** warned. (Total: **${count}**)\nReason: ${reason}\n` +
        (count >= 3 ? `\n🚨 **Auto-action triggered** (${count} warnings)` : "")
      );
      try { await target.send(`⚠️ You were warned in **${message.guild.name}**.\nReason: ${reason}\nTotal warnings: **${count}**`); } catch {}
    }

    // ── !warnings [@user] ─────────────────────────────────────────────────────
    if (command === "warnings") {
      const target = message.mentions.members?.first() ?? message.member;
      if (!target) return;
      const list = getWarnings(message.guild.id, target.id);
      if (list.length === 0) return void message.reply(`✅ **${target.user.tag}** has no warnings.`);
      await message.reply(
        `📋 **Warnings for ${target.user.tag}** (${list.length} total):\n` +
        list.map((w, i) => `**${i + 1}.** ${w}`).join("\n")
      );
    }

    // ── !clearwarns @user ─────────────────────────────────────────────────────
    if (command === "clearwarns") {
      if (!hasAdminPerm(message)) return void message.reply("❌ You need **Administrator** permission.");
      const target = message.mentions.members?.first();
      if (!target) return void message.reply("Usage: `!clearwarns @user`");
      clearWarnings(message.guild.id, target.id);
      await message.reply(`✅ All warnings cleared for **${target.user.tag}**.`);
    }

    // ── !slowmode [seconds] ────────────────────────────────────────────────────
    if (command === "slowmode") {
      if (!hasPerm(message, PermissionFlagsBits.ManageChannels))
        return void message.reply("❌ You need **Manage Channels** permission.");
      const seconds = Math.min(parseInt(args[0] ?? "0", 10) || 0, 21600);
      try {
        await (message.channel as TextChannel).setRateLimitPerUser(seconds);
        await message.reply(seconds === 0 ? "✅ Slowmode **disabled**." : `✅ Slowmode set to **${seconds}s**.`);
      } catch { await message.reply("❌ Couldn't change slowmode."); }
    }

    // ── !lock / !unlock ────────────────────────────────────────────────────────
    if (command === "lock") {
      if (!hasPerm(message, PermissionFlagsBits.ManageChannels))
        return void message.reply("❌ You need **Manage Channels** permission.");
      try {
        await (message.channel as TextChannel).permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        await message.reply("🔒 Channel **locked**.");
      } catch { await message.reply("❌ Couldn't lock."); }
    }

    if (command === "unlock") {
      if (!hasPerm(message, PermissionFlagsBits.ManageChannels))
        return void message.reply("❌ You need **Manage Channels** permission.");
      try {
        await (message.channel as TextChannel).permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        await message.reply("🔓 Channel **unlocked**.");
      } catch { await message.reply("❌ Couldn't unlock."); }
    }

    // ── !role @user @role ──────────────────────────────────────────────────────
    if (command === "role") {
      if (!hasPerm(message, PermissionFlagsBits.ManageRoles))
        return void message.reply("❌ You need **Manage Roles** permission.");
      const target = message.mentions.members?.first();
      const role = message.mentions.roles.first();
      if (!target || !role) return void message.reply("Usage: `!role @user @role`");
      try {
        if (target.roles.cache.has(role.id)) {
          await target.roles.remove(role);
          await message.reply(`✅ Removed **${role.name}** from **${target.user.tag}**.`);
        } else {
          await target.roles.add(role);
          await message.reply(`✅ Added **${role.name}** to **${target.user.tag}**.`);
        }
      } catch { await message.reply("❌ Couldn't manage that role."); }
    }

    // ── !serverinfo ────────────────────────────────────────────────────────────
    if (command === "serverinfo") {
      const guild = message.guild;
      await guild.fetch().catch(() => {});
      const embed = new EmbedBuilder()
        .setTitle(`📊 ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
        .addFields(
          { name: "👑 Owner", value: `<@${guild.ownerId}>`, inline: true },
          { name: "👥 Members", value: `${guild.memberCount}`, inline: true },
          { name: "📅 Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          { name: "💬 Channels", value: `${guild.channels.cache.size}`, inline: true },
          { name: "🎭 Roles", value: `${guild.roles.cache.size}`, inline: true },
          { name: "😀 Emojis", value: `${guild.emojis.cache.size}`, inline: true },
        )
        .setColor(0x5865f2)
        .setFooter({ text: `ID: ${guild.id}` });
      await message.reply({ embeds: [embed] });
    }

    // ── !userinfo [@user] ──────────────────────────────────────────────────────
    if (command === "userinfo") {
      const target: GuildMember = message.mentions.members?.first() ?? message.member!;
      const warns = getWarnings(message.guild.id, target.id).length;
      const roles = target.roles.cache
        .filter((r) => r.id !== message.guild!.id)
        .map((r) => r.toString()).slice(0, 10).join(", ") || "None";
      const embed = new EmbedBuilder()
        .setTitle(`👤 ${target.user.tag}`)
        .setThumbnail(target.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: "🆔 User ID", value: target.id, inline: true },
          { name: "🤖 Bot?", value: target.user.bot ? "Yes" : "No", inline: true },
          { name: "⚠️ Warnings", value: `${warns}`, inline: true },
          { name: "📅 Joined Server", value: `<t:${Math.floor((target.joinedTimestamp ?? 0) / 1000)}:D>`, inline: true },
          { name: "📅 Account Created", value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:D>`, inline: true },
          { name: "🎭 Roles", value: roles },
        )
        .setColor(0x57f287)
        .setFooter({ text: `Requested by ${message.author.tag}` });
      await message.reply({ embeds: [embed] });
    }
  });
}
