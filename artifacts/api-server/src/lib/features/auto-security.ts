import { isClaimed } from "../message-gate.js";
import {
  Client,
  Events,
  Message,
  GuildMember,
  TextChannel,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import { pool } from "@workspace/db";

// ─── Self-contained security warning system (persisted to DB) ────────────────
const _secWarnings = new Map<string, Map<string, string[]>>();

async function addWarningAndCheck(
  guildId: string,
  userId: string,
  reason: string,
  member: GuildMember,
  notifyChannel?: TextChannel,
): Promise<void> {
  if (!_secWarnings.has(guildId)) _secWarnings.set(guildId, new Map());
  const guildWarns = _secWarnings.get(guildId)!;
  const list = guildWarns.get(userId) ?? [];
  list.push(reason);
  guildWarns.set(userId, list);
  const count = list.length;

  // Persist to DB (table created by initModeration / initAutoSecurity)
  try {
    await pool.query(
      `INSERT INTO user_warnings (guild_id, user_id, reason, source) VALUES ($1, $2, $3, 'security')`,
      [guildId, userId, reason]
    );
  } catch (err) {
    console.error("[AutoSecurity] Failed to persist warning to DB:", err);
  }

  if (count === 3) {
    try {
      await member.send(`⚠️ You have 3 security violations in **${member.guild.name}** and have been auto-kicked.\nLatest: ${reason}`).catch(() => {});
      await member.kick("Auto-security: 3 violations");
      await notifyChannel?.send(`🦶 ${member.user.tag} auto-kicked after 3 security violations.`).catch(() => {});
    } catch {}
  }
  if (count >= 5) {
    try {
      await member.send(`🔨 You have 5+ security violations in **${member.guild.name}** and have been auto-banned.`).catch(() => {});
      await member.ban({ reason: "Auto-security: 5 violations" });
      await notifyChannel?.send(`🔨 ${member.user.tag} auto-banned after 5 security violations.`).catch(() => {});
    } catch {}
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SPAM_MSG_LIMIT      = 5;
const SPAM_WINDOW_MS      = 5000;
const SPAM_MUTE_MIN       = 10;
const RAID_JOIN_LIMIT     = 8;
const RAID_WINDOW_MS      = 20000;
const NEW_ACCOUNT_DAYS    = 7;
const MASS_MENTION_LIMIT  = 5;
const REPEAT_MSG_LIMIT    = 3;
const REPEAT_WINDOW_MS    = 15000;
const CAPS_THRESHOLD      = 0.70;  // 70% caps = delete
const CAPS_MIN_LENGTH     = 15;    // only check if message is long enough
const AUTO_SLOWMODE_LIMIT = 15;    // msgs per minute per channel
const AUTO_SLOWMODE_SEC   = 10;    // slowmode seconds to apply
const ALT_REJOIN_LIMIT    = 3;     // rejoin count before flagging

// ─── Known phishing / scam domains ───────────────────────────────────────────
const PHISHING_DOMAINS = [
  "discordnitro", "discord-gift", "freenitr", "steamgift", "free-steam",
  "dlscord", "discoord", "discordapp.gift", "claimnitro", "nitrogift",
  "discord.gift.com", "gift-discord", "free-discord", "discordnitro.com",
  "notamaliciousdomain",
];

// ─── Nitro scam patterns ──────────────────────────────────────────────────────
const NITRO_SCAM_PATTERNS = [
  /free\s*nitro/i,
  /claim\s*(your)?\s*nitro/i,
  /discord\s*nitro\s*giveaway/i,
  /you('ve| have) won\s*(a|discord)?\s*nitro/i,
  /get\s*nitro\s*for\s*free/i,
  /steam\s*gift\s*card/i,
  /click\s*here\s*to\s*claim/i,
  /airdrop\s*claim/i,
];

// ─── Dangerous file extensions ────────────────────────────────────────────────
const DANGEROUS_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".sh", ".ps1", ".vbs", ".msi",
  ".scr", ".pif", ".jar", ".reg", ".com",
];

// ─── State ────────────────────────────────────────────────────────────────────
const spamTracker    = new Map<string, number[]>();
const raidTracker    = new Map<string, number[]>();
const repeatTracker  = new Map<string, { text: string; times: number[] }>();
const lockedDown     = new Set<string>();
export const logChannels = new Map<string, string>();
// channelId → message timestamps for auto-slowmode
const channelMsgRate = new Map<string, number[]>();
// guildId → userId → join timestamps
const altTracker     = new Map<string, Map<string, number[]>>();

// ─── DB init + load ───────────────────────────────────────────────────────────
export async function initAutoSecurity(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_log_config (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  const { rows } = await pool.query(`SELECT guild_id, channel_id FROM security_log_config`);
  for (const row of rows) logChannels.set(row.guild_id, row.channel_id);
  console.log(`Loaded ${rows.length} security log channel(s) from DB`);

  // Load persisted security warnings into memory
  try {
    const { rows: warnRows } = await pool.query<{ guild_id: string; user_id: string; reason: string }>(
      `SELECT guild_id, user_id, reason FROM user_warnings WHERE source = 'security' ORDER BY id`
    );
    for (const row of warnRows) {
      if (!_secWarnings.has(row.guild_id)) _secWarnings.set(row.guild_id, new Map());
      const guildWarns = _secWarnings.get(row.guild_id)!;
      const list = guildWarns.get(row.user_id) ?? [];
      list.push(row.reason);
      guildWarns.set(row.user_id, list);
    }
    console.log(`[AutoSecurity] Loaded ${warnRows.length} security warning(s) from DB`);
  } catch {
    // user_warnings table may not exist yet if initModeration hasn't run; safe to ignore
  }
}

function now() { return Date.now(); }

// ─── Security log helper ──────────────────────────────────────────────────────
async function sendSecurityLog(client: Client, guildId: string, embed: EmbedBuilder) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const manualId = logChannels.get(guildId);
  if (manualId) {
    const ch = guild.channels.cache.get(manualId) as TextChannel | undefined;
    if (ch) { await ch.send({ embeds: [embed] }).catch(() => {}); return; }
  }
  const fallback = guild.channels.cache.find(
    (ch) => ch.isTextBased() &&
      (ch.name.includes("security") || ch.name.includes("mod-log") || ch.name.includes("logs"))
  ) as TextChannel | undefined;
  if (fallback) await fallback.send({ embeds: [embed] }).catch(() => {});
}

async function alertAdmins(client: Client, guildId: string, title: string, text: string, color = 0xff0000) {
  const embed = new EmbedBuilder()
    .setTitle(`🚨 ${title}`)
    .setDescription(text)
    .setColor(color)
    .setTimestamp();
  await sendSecurityLog(client, guildId, embed);
}

// ─── Register ─────────────────────────────────────────────────────────────────
export function registerAutoSecurity(client: Client) {

  // ══ ON MEMBER JOIN ══════════════════════════════════════════════════════════

  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    const guildId = member.guild.id;

    // ── New account protection ───────────────────────────────────────────────
    const ageDays = (now() - member.user.createdTimestamp) / 86400000;
    if (ageDays < NEW_ACCOUNT_DAYS) {
      try {
        await member.send(
          `👋 Your account is too new (${Math.floor(ageDays)} days old) to join **${member.guild.name}**.\n` +
          `Please try again when your account is at least ${NEW_ACCOUNT_DAYS} days old.`
        ).catch(() => {});
        await member.kick("Auto-security: account too new");
        await alertAdmins(client, guildId, "New Account Kicked",
          `🚫 **${member.user.tag}** was kicked — account age: **${Math.floor(ageDays)} days**`
        );
      } catch {}
      return;
    }

    // ── Alt account detection (multiple rejoin) ──────────────────────────────
    if (!altTracker.has(guildId)) altTracker.set(guildId, new Map());
    const guildAlts = altTracker.get(guildId)!;
    const joinHistory = guildAlts.get(member.id) ?? [];
    joinHistory.push(now());
    guildAlts.set(member.id, joinHistory);
    if (joinHistory.length >= ALT_REJOIN_LIMIT) {
      await alertAdmins(client, guildId, "Possible Alt / Rejoin Detected",
        `⚠️ **${member.user.tag}** (<@${member.id}>) has joined this server **${joinHistory.length} times**.\n` +
        `This may be an alt account or someone trying to evade a ban.`,
        0xff9900
      );
    }

    // ── Raid detection ────────────────────────────────────────────────────────
    const joins = (raidTracker.get(guildId) ?? []).filter((t) => now() - t < RAID_WINDOW_MS);
    joins.push(now());
    raidTracker.set(guildId, joins);

    if (joins.length >= RAID_JOIN_LIMIT && !lockedDown.has(guildId)) {
      lockedDown.add(guildId);
      const guild = member.guild;
      let locked = 0;
      for (const [, ch] of guild.channels.cache) {
        if (ch instanceof TextChannel) {
          await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
          locked++;
        }
      }
      await alertAdmins(client, guildId, "🔒 RAID DETECTED — Server Locked",
        `**${joins.length} members** joined in under 20 seconds!\n` +
        `**${locked} channels locked** automatically.\nAuto-unlock in 10 minutes.`
      );
      setTimeout(async () => {
        lockedDown.delete(guildId);
        for (const [, ch] of guild.channels.cache) {
          if (ch instanceof TextChannel) {
            await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
          }
        }
        await alertAdmins(client, guildId, "🔓 Raid Lockdown Lifted",
          "Lockdown automatically lifted after 10 minutes. All channels re-opened."
        );
      }, 10 * 60 * 1000);
    }
  });

  // Track member leaves for alt detection
  client.on(Events.GuildMemberRemove, (member) => {
    // Keep join history — don't remove so we can count rejoins
  });

  // ══ ON MESSAGE ══════════════════════════════════════════════════════════════

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    const isMod = message.member?.permissions.has(PermissionFlagsBits.ManageMessages);
    if (isMod) return;

    const userId    = message.author.id;
    const guildId   = message.guild.id;
    const content   = message.content.trim();

    // ── Anti-invite links ────────────────────────────────────────────────────
    const inviteRegex = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/[\w-]+/i;
    if (inviteRegex.test(content)) {
      await message.delete().catch(() => {});
      const w = await (message.channel as any).send(
        `🚫 ${message.author}, server invite links are not allowed!`
      );
      setTimeout(() => w.delete().catch(() => {}), 5_000);
      if (message.member) {
        await addWarningAndCheck(guildId, userId, "Posted a server invite link", message.member, message.channel as TextChannel);
      }
      await alertAdmins(client, guildId, "Invite Link Blocked",
        `📨 **${message.author.tag}** tried to post an invite link in <#${message.channelId}>`, 0xff9900
      );
      return;
    }

    // ── Phishing / scam domain detection ─────────────────────────────────────
    const lowerContent = content.toLowerCase();
    const foundPhishing = PHISHING_DOMAINS.find((d) => lowerContent.includes(d));
    if (foundPhishing) {
      await message.delete().catch(() => {});
      await (message.channel as any).send(
        `🚨 ${message.author}, a **potentially dangerous link** was detected and removed!`
      );
      if (message.member) {
        await message.member.timeout(30 * 60 * 1000, "Auto-security: phishing link");
        await addWarningAndCheck(guildId, userId, "Posted a phishing/scam link", message.member, message.channel as TextChannel);
      }
      await alertAdmins(client, guildId, "⚠️ Phishing Link Detected",
        `🎣 **${message.author.tag}** posted a suspicious link matching \`${foundPhishing}\` in <#${message.channelId}>.\nMuted 30 min + warned.`
      );
      return;
    }

    // ── Nitro scam detection ──────────────────────────────────────────────────
    const isNitroScam = NITRO_SCAM_PATTERNS.some((p) => p.test(content));
    if (isNitroScam) {
      await message.delete().catch(() => {});
      await (message.channel as any).send(
        `🚫 ${message.author}, **Nitro/gift scam** messages are not allowed!`
      );
      if (message.member) {
        await message.member.timeout(60 * 60 * 1000, "Auto-security: nitro scam");
        await addWarningAndCheck(guildId, userId, "Posted a Nitro scam message", message.member, message.channel as TextChannel);
      }
      await alertAdmins(client, guildId, "Nitro Scam Detected",
        `💎 **${message.author.tag}** posted a Nitro scam in <#${message.channelId}>. Muted 1 hour + warned.`
      );
      return;
    }

    // ── Dangerous file extension ──────────────────────────────────────────────
    for (const attachment of message.attachments.values()) {
      const name = (attachment.name ?? "").toLowerCase();
      const isDangerous = DANGEROUS_EXTENSIONS.some((ext) => name.endsWith(ext));
      if (isDangerous) {
        await message.delete().catch(() => {});
        await (message.channel as any).send(
          `🚫 ${message.author}, files with that extension (**${name.split(".").pop()}**) are not allowed for security reasons.`
        );
        if (message.member) {
          await addWarningAndCheck(guildId, userId, `Uploaded dangerous file: ${name}`, message.member, message.channel as TextChannel);
        }
        await alertAdmins(client, guildId, "Dangerous File Blocked",
          `📎 **${message.author.tag}** tried to upload \`${name}\` in <#${message.channelId}>.`
        );
        return;
      }
    }

    // ── Caps filter ───────────────────────────────────────────────────────────
    if (content.length >= CAPS_MIN_LENGTH) {
      const letters = content.replace(/[^a-zA-Z]/g, "");
      const capsRatio = letters.length > 0 ? (content.replace(/[^A-Z]/g, "").length / letters.length) : 0;
      if (capsRatio >= CAPS_THRESHOLD) {
        await message.delete().catch(() => {});
        const w = await (message.channel as any).send(
          `🔤 ${message.author}, please don't use excessive caps!`
        );
        setTimeout(() => w.delete().catch(() => {}), 4_000);
        return;
      }
    }

    // ── Anti @everyone / @here ────────────────────────────────────────────────
    if (
      (message.mentions.everyone || /@(everyone|here)/.test(content)) &&
      !message.member?.permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
      await message.delete().catch(() => {});
      const w = await (message.channel as any).send(
        `🚫 ${message.author}, you don't have permission to use @everyone or @here!`
      );
      setTimeout(() => w.delete().catch(() => {}), 5_000);
      if (message.member) {
        await addWarningAndCheck(guildId, userId, "Attempted @everyone or @here without permission", message.member, message.channel as TextChannel);
      }
      return;
    }

    // ── Mass mention ──────────────────────────────────────────────────────────
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    if (mentionCount >= MASS_MENTION_LIMIT) {
      await message.delete().catch(() => {});
      if (message.member) {
        await message.member.timeout(15 * 60 * 1000, "Auto-security: mass mention");
        await addWarningAndCheck(guildId, userId, `Mass mention of ${mentionCount} users/roles`, message.member, message.channel as TextChannel);
      }
      await (message.channel as any).send(`🚨 ${message.author} was muted **15 min** for mass-mentioning **${mentionCount}** users/roles.`);
      await alertAdmins(client, guildId, "Mass Mention",
        `📣 **${message.author.tag}** mentioned ${mentionCount} targets in <#${message.channelId}>.`
      );
      return;
    }

    // ── Anti-spam ─────────────────────────────────────────────────────────────
    const userMsgs = (spamTracker.get(userId) ?? []).filter((t) => now() - t < SPAM_WINDOW_MS);
    userMsgs.push(now());
    spamTracker.set(userId, userMsgs);
    if (userMsgs.length >= SPAM_MSG_LIMIT) {
      spamTracker.delete(userId);
      if (message.member) {
        await message.member.timeout(SPAM_MUTE_MIN * 60 * 1000, "Auto-security: spam");
        await addWarningAndCheck(guildId, userId, "Spamming messages", message.member, message.channel as TextChannel);
      }
      await (message.channel as any).send(`🚨 ${message.author} was muted **${SPAM_MUTE_MIN} min** for spamming.`);
      await alertAdmins(client, guildId, "Spam Detected",
        `💬 **${message.author.tag}** sent ${userMsgs.length} msgs in 5s in <#${message.channelId}>.`
      );
      return;
    }

    // ── Repeat message ────────────────────────────────────────────────────────
    const repeat = repeatTracker.get(userId);
    const recentRepeat = (repeat?.times ?? []).filter((t) => now() - t < REPEAT_WINDOW_MS);
    if (repeat?.text === content.toLowerCase()) {
      recentRepeat.push(now());
      repeatTracker.set(userId, { text: content.toLowerCase(), times: recentRepeat });
      if (recentRepeat.length >= REPEAT_MSG_LIMIT) {
        repeatTracker.delete(userId);
        await message.delete().catch(() => {});
        if (message.member) {
          await message.member.timeout(5 * 60 * 1000, "Auto-security: repeat message");
        }
        await (message.channel as any).send(`⚠️ ${message.author} was muted **5 min** for repeating the same message.`);
      }
    } else {
      repeatTracker.set(userId, { text: content.toLowerCase(), times: [now()] });
    }

    // ── Auto-slowmode (channel rate) ──────────────────────────────────────────
    const chMsgs = (channelMsgRate.get(message.channelId) ?? []).filter((t) => now() - t < 60000);
    chMsgs.push(now());
    channelMsgRate.set(message.channelId, chMsgs);
    if (chMsgs.length === AUTO_SLOWMODE_LIMIT) {
      try {
        await (message.channel as TextChannel).setRateLimitPerUser(AUTO_SLOWMODE_SEC);
        const w = await (message.channel as any).send(
          `⏱️ Slow mode enabled (**${AUTO_SLOWMODE_SEC}s**) due to high message volume. It will lift automatically.`
        );
        setTimeout(async () => {
          await (message.channel as TextChannel).setRateLimitPerUser(0).catch(() => {});
          await w.delete().catch(() => {});
          channelMsgRate.delete(message.channelId);
        }, 3 * 60 * 1000);
      } catch {}
    }
  });

  // ══ SETLOG COMMANDS ═════════════════════════════════════════════════════════

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim();

    if (content === "!setlog" || content.startsWith("!setlog ")) {
      const mentioned = message.mentions.channels.first() as TextChannel | undefined;
      const target = mentioned ?? (message.channel as TextChannel);
      logChannels.set(message.guild.id, target.id);
      await pool.query(
        `INSERT INTO security_log_config (guild_id, channel_id) VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
        [message.guild.id, target.id]
      );
      await message.reply(
        `✅ Security log channel set to ${target}.\nAll auto-security alerts will be sent there.\nUse \`!removelog\` to clear.`
      );
    }

    if (content === "!removelog") {
      if (logChannels.has(message.guild.id)) {
        logChannels.delete(message.guild.id);
        await pool.query(`DELETE FROM security_log_config WHERE guild_id = $1`, [message.guild.id]);
        await message.reply("✅ Security log channel removed.");
      } else {
        await message.reply("No log channel was set.");
      }
    }

    if (content === "!securitystatus") {
      const logId = logChannels.get(message.guild.id);
      await message.reply([
        "🛡️ **Auto-Security Status**",
        `📋 Log channel: ${logId ? `<#${logId}>` : "Not set"}`,
        `🔒 Raid lockdown: ${lockedDown.has(message.guild.id) ? "**ACTIVE ⚠️**" : "Inactive ✅"}`,
        "",
        "**Active protections:**",
        `🆕 New account protection: <${NEW_ACCOUNT_DAYS} days → kick`,
        `💬 Anti-spam: ${SPAM_MSG_LIMIT} msgs/${SPAM_WINDOW_MS / 1000}s → mute ${SPAM_MUTE_MIN} min`,
        `📣 Anti-mass-mention: ${MASS_MENTION_LIMIT}+ mentions → mute 15 min`,
        `🔁 Anti-repeat: same msg ${REPEAT_MSG_LIMIT}× → mute 5 min`,
        `🚨 Anti-raid: ${RAID_JOIN_LIMIT}+ joins/${RAID_WINDOW_MS / 1000}s → lockdown`,
        `📨 Anti-invite: Discord invites → deleted + warned`,
        `🎣 Anti-phishing: known scam domains → mute 30 min`,
        `💎 Anti-nitro scam: scam messages → mute 1 hour`,
        `📎 File filter: dangerous extensions (.exe, .bat...) → blocked`,
        `🔤 Caps filter: ${Math.round(CAPS_THRESHOLD * 100)}%+ caps → deleted`,
        `@️⃣ Anti-everyone: unauthorized @everyone → warned`,
        `⏱️ Auto-slowmode: ${AUTO_SLOWMODE_LIMIT}+ msgs/min → ${AUTO_SLOWMODE_SEC}s slowmode`,
        `👥 Alt detection: ${ALT_REJOIN_LIMIT}+ rejoins → alert`,
      ].join("\n"));
    }
  });
}
