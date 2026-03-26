import {
  Client,
  Events,
  Message,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  TextChannel,
  PermissionFlagsBits,
} from "discord.js";
import { pool } from "@workspace/db";

let botStartTime: Date | null = null;

export function setBotStartTime(d: Date) {
  botStartTime = d;
}

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initBotHealth(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_health_channels (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
}

export async function getBotHealthChannel(guildId: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT channel_id FROM bot_health_channels WHERE guild_id = $1`,
    [guildId]
  );
  return res.rows[0]?.channel_id ?? null;
}

export async function setBotHealthChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO bot_health_channels (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
    [guildId, channelId]
  );
}

// ─── Build health embed ───────────────────────────────────────────────────────
function buildHealthEmbed(client: Client): EmbedBuilder {
  const uptimeMs = botStartTime ? Date.now() - botStartTime.getTime() : 0;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const uptimeStr = `${h}h ${m}m ${s}s`;

  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("💚 Bot Health Status")
    .addFields(
      { name: "Status",   value: "🟢 Online",                                      inline: true },
      { name: "Ping",     value: `${Math.round(client.ws.ping)}ms`,                inline: true },
      { name: "Uptime",   value: uptimeStr,                                         inline: true },
      { name: "Guilds",   value: `${client.guilds.cache.size}`,                    inline: true },
      { name: "Users",    value: `${client.users.cache.size}`,                     inline: true },
      { name: "Channels", value: `${client.channels.cache.size}`,                  inline: true },
    )
    .setFooter({ text: `PIXEL_PR • ${new Date().toUTCString()}` });
}

// ─── Text command handlers ────────────────────────────────────────────────────
async function handleSetHealthChannel(message: Message, args: string[]): Promise<void> {
  if (!message.guild) { await message.reply("This command only works in servers."); return; }
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply("❌ Only admins can use this command."); return;
  }
  const mention = args[0];
  const channelId = mention?.replace(/[<#>]/g, "");
  if (!channelId) {
    await message.reply("**Usage:** `!sethealthchannel #channel`"); return;
  }
  const ch = message.guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch) { await message.reply("❌ Channel not found."); return; }

  await setBotHealthChannel(message.guild.id, channelId);
  await message.reply(
    `✅ Bot health reports and error alerts will be sent to ${ch}.\nUse \`!health\` anytime for a live status check.`
  );
}

async function handleHealth(message: Message, client: Client): Promise<void> {
  await message.reply({ embeds: [buildHealthEmbed(client)] });
}

// ─── Slash command handlers ───────────────────────────────────────────────────
export async function slashSetHealthChannel(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  if (!interaction.guild) { await interaction.reply({ content: "This command only works in servers.", ephemeral: true }); return; }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ Only admins can use this command.", ephemeral: true }); return;
  }
  const ch = interaction.options.getChannel("channel", true) as TextChannel;
  await setBotHealthChannel(interaction.guild.id, ch.id);
  await interaction.reply(
    `✅ Bot health reports and error alerts will be sent to ${ch}.\nUse \`/health\` anytime for a live status check.`
  );
}

export async function slashHealth(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  await interaction.reply({ embeds: [buildHealthEmbed(client)] });
}

// ─── Register ─────────────────────────────────────────────────────────────────
export function registerBotHealth(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith("!")) return;
    const [rawCmd, ...args] = message.content.slice(1).trim().split(/\s+/);
    const cmd = rawCmd?.toLowerCase();
    if (cmd === "sethealthchannel") await handleSetHealthChannel(message, args);
    if (cmd === "health") await handleHealth(message, client);
  });
}
