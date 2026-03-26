// ─── AI-Generated Plugin Registry ────────────────────────────────────────────
// This file is AUTOMATICALLY MANAGED by the AI Coder engine (/build command).
// New plugins are appended when users run /build.
// Each plugin is a fully self-contained slash command with its own handler.
//
// DO NOT EDIT MANUALLY — edits may be overwritten by the AI Coder engine.

import type { ChatInputCommandInteraction } from "discord.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  Colors,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";
import { pool }  from "@workspace/db";

export interface AIPlugin {
  name:       string;
  /** null / undefined = global (all servers). A guild ID string = this server only. */
  guildId?:   string | null;
  definition: ReturnType<SlashCommandBuilder["toJSON"]>;
  handler:    (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ── AI PLUGINS START ──────────────────────────────────────────────────────────
// (Plugins are appended above this line by the AI Coder engine)
// ── AI PLUGINS END ────────────────────────────────────────────────────────────

export const aiPluginCommands: AIPlugin[] = [
  // ── AI PLUGINS ARRAY START ────────────────────────────────────────────────
  // (Plugin entries are appended above this line by the AI Coder engine)

  // ─── /joke ────────────────────────────────────────────────────────────────
  {
    name: "joke",
    guildId: null,
    definition: new SlashCommandBuilder()
      .setName("joke")
      .setDescription("Generates a random anime/manga joke or quote and posts it in a channel.")
      .addChannelOption(o =>
        o.setName("channel")
          .setDescription("The channel where the joke will be posted.")
          .setRequired(true)
      )
      .toJSON(),
    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      try {
        if (!interaction.inGuild() || !interaction.guild) {
          await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
          return;
        }

        const targetChannel = interaction.options.getChannel("channel", true) as any;

        if (!(targetChannel as any).isTextBased?.() || (targetChannel as any).isThread?.()) {
          await interaction.reply({
            content: "I can only post jokes in standard text channels.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const botPermissions = (targetChannel as any).permissionsFor(interaction.guild?.members?.me);
        if (!botPermissions?.has(PermissionFlagsBits.SendMessages)) {
          await interaction.reply({
            content: `I don't have permission to send messages in ${targetChannel}. Please grant me the 'Send Messages' permission.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const jokeContent = await generateWithFallback({
          contents: [{
            role: "user",
            parts: [{ text: "Generate a single short funny joke or witty quote from anime/manga. Format:\nJoke or quote text\n- Character Name, *Series Title*" }],
          }],
        });

        if (!jokeContent) {
          await interaction.editReply({ content: "Sorry, the AI couldn't generate a joke right now. Please try again!" });
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("😄 Anime & Manga Funnies")
          .setDescription(jokeContent)
          .setTimestamp()
          .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        await (targetChannel as any).send({ embeds: [embed] });
        await interaction.editReply({ content: `✅ Joke posted in ${targetChannel}!` });

      } catch (error) {
        console.error("[/joke] Error:", error);
        const msg = "Sorry, I couldn't tell a joke right now. Please try again later.";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: msg }).catch(console.error);
        } else {
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(console.error);
        }
      }
    },
  },

  // ─── /news-alerts ─────────────────────────────────────────────────────────
  {
    name: "news-alerts",
    guildId: null,
    definition: new SlashCommandBuilder()
      .setName("news-alerts")
      .setDescription("Manage Twitter/X news alerts for a channel.")
      .addSubcommand(sub =>
        sub.setName("add")
          .setDescription("Add a Twitter/X user to send alerts to a channel.")
          .addStringOption(o => o.setName("username").setDescription("Twitter/X username (without @)").setRequired(true))
          .addChannelOption(o => o.setName("channel").setDescription("Channel to post alerts in").setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName("remove")
          .setDescription("Remove a Twitter/X user's alerts from a channel.")
          .addStringOption(o => o.setName("username").setDescription("Twitter/X username (without @)").setRequired(true))
          .addChannelOption(o => o.setName("channel").setDescription("Channel to remove alerts from").setRequired(true))
      )
      .addSubcommand(sub =>
        sub.setName("list")
          .setDescription("List all active Twitter/X alerts for a channel.")
          .addChannelOption(o => o.setName("channel").setDescription("Channel to list alerts for (defaults to current)").setRequired(false))
      )
      .toJSON(),
    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({ content: "You need 'Manage Channels' permission to use this command.", flags: MessageFlags.Ephemeral });
          return;
        }

        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
          return;
        }

        // Ensure news_alerts table exists
        await pool.query(`
          CREATE TABLE IF NOT EXISTS news_alerts (
            id               SERIAL PRIMARY KEY,
            guild_id         TEXT NOT NULL,
            channel_id       TEXT NOT NULL,
            twitter_username TEXT NOT NULL,
            created_at       TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (guild_id, channel_id, twitter_username)
          )
        `);

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === "add") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const username = interaction.options.getString("username", true).replace(/^@/, "").trim();
          const channel = interaction.options.getChannel("channel", true) as any;

          if (!(channel as any).isTextBased() || (channel as any).isVoiceBased()) {
            await interaction.editReply({ content: `<#${channel.id}> is not a text channel.` });
            return;
          }

          const { rows: existing } = await pool.query(
            "SELECT 1 FROM news_alerts WHERE guild_id = $1 AND channel_id = $2 AND twitter_username = $3",
            [guildId, channel.id, username.toLowerCase()]
          );
          if (existing.length > 0) {
            await interaction.editReply({ content: `Alerts for **@${username}** are already set up in <#${channel.id}>.` });
            return;
          }

          await pool.query(
            "INSERT INTO news_alerts (guild_id, channel_id, twitter_username) VALUES ($1, $2, $3)",
            [guildId, channel.id, username.toLowerCase()]
          );
          await interaction.editReply({ content: `✅ News alerts for **@${username}** will be posted in <#${channel.id}>.` });

        } else if (subcommand === "remove") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const username = interaction.options.getString("username", true).replace(/^@/, "").trim();
          const channel = interaction.options.getChannel("channel", true) as any;

          const { rowCount } = await pool.query(
            "DELETE FROM news_alerts WHERE guild_id = $1 AND channel_id = $2 AND twitter_username = $3",
            [guildId, channel.id, username.toLowerCase()]
          );
          if (rowCount) {
            await interaction.editReply({ content: `✅ Removed news alerts for **@${username}** from <#${channel.id}>.` });
          } else {
            await interaction.editReply({ content: `No alerts found for **@${username}** in <#${channel.id}>.` });
          }

        } else if (subcommand === "list") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = (interaction.options.getChannel("channel") ?? interaction.channel) as any;

          if (!channel) {
            await interaction.editReply({ content: "Could not determine the channel." });
            return;
          }

          const { rows } = await pool.query(
            "SELECT twitter_username FROM news_alerts WHERE guild_id = $1 AND channel_id = $2 ORDER BY twitter_username ASC",
            [guildId, channel.id]
          );

          if (rows.length === 0) {
            await interaction.editReply({ content: `No news alerts configured for <#${channel.id}>.` });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle(`📰 News Alerts in #${channel.name}`)
            .setColor(Colors.Blue)
            .setDescription(rows.map((r: any) => `• @${r.twitter_username}`).join("\n"));

          await interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error("[/news-alerts] Error:", error);
        const msg = { content: "An error occurred. Please try again later." };
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ ...msg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    },
  },
  // ── AI PLUGINS ARRAY END ─────────────────────────────────────────────────
];
