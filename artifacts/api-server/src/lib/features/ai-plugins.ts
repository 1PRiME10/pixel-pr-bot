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
import { NEWS_SOURCES, setNewsChannel, stopNewsAlerts, getNewsConfig } from "./news-monitor.js";
import { TV_SOURCES, setTVNewsChannel, stopTVNews, getTVNewsConfig } from "./tv-news-monitor.js";

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
  // RSS-based breaking news from official Arabic / International / Japanese sources.
  // No Twitter required — pulls directly from official websites every 15 minutes.
  {
    name: "news-alerts",
    guildId: null,
    definition: new SlashCommandBuilder()
      .setName("news-alerts")
      .setDescription("Breaking news from official Arabic, international & Japanese sources.")
      .addSubcommand(sub =>
        sub.setName("set")
          .setDescription("Set the channel where breaking news will be posted.")
          .addChannelOption(o =>
            o.setName("channel")
             .setDescription("Text channel to receive breaking news")
             .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName("stop")
          .setDescription("Stop posting news alerts in this server.")
      )
      .addSubcommand(sub =>
        sub.setName("status")
          .setDescription("Show current configuration and list of news sources.")
      )
      .toJSON(),

    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({
            content: "❌ You need **Manage Channels** permission to use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
          return;
        }

        const sub = interaction.options.getSubcommand();

        // ── /news-alerts set ──────────────────────────────────────────────────
        if (sub === "set") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = interaction.options.getChannel("channel", true) as any;

          if (!channel.isTextBased() || channel.isVoiceBased()) {
            await interaction.editReply({ content: `❌ <#${channel.id}> is not a text channel.` });
            return;
          }

          await setNewsChannel(guildId, channel.id);

          const arabicSources    = NEWS_SOURCES.filter(s => s.lang === "ar");
          const intlSources      = NEWS_SOURCES.filter(s => s.lang === "en");
          const japaneseSources  = NEWS_SOURCES.filter(s => s.lang === "ja");

          const embed = new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("📰 News Alerts Activated")
            .setDescription(`Breaking news will be posted in <#${channel.id}> every **5 minutes** automatically.`)
            .addFields(
              {
                name: "🌍 Arabic Sources",
                value: arabicSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🌐 International Sources",
                value: intlSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🇯🇵 Japanese Sources",
                value: japaneseSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
            )
            .setFooter({ text: "Live news from official sources — no Twitter required" });

          await interaction.editReply({ embeds: [embed] });

        // ── /news-alerts stop ─────────────────────────────────────────────────
        } else if (sub === "stop") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const stopped = await stopNewsAlerts(guildId);
          if (stopped) {
            await interaction.editReply({ content: "✅ News alerts have been stopped for this server." });
          } else {
            await interaction.editReply({ content: "⚠️ News alerts were not active." });
          }

        // ── /news-alerts status ───────────────────────────────────────────────
        } else if (sub === "status") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const config = await getNewsConfig(guildId);

          if (!config) {
            await interaction.editReply({
              content: "📭 News alerts are not configured yet.\nUse `/news-alerts set` to activate them.",
            });
            return;
          }

          const statusEmoji = config.enabled ? "✅ Active" : "⛔ Stopped";
          const embed = new EmbedBuilder()
            .setColor(config.enabled ? Colors.Green : Colors.Red)
            .setTitle("📰 News Alerts Status")
            .addFields(
              { name: "Status",  value: statusEmoji,                           inline: true },
              { name: "Channel", value: `<#${config.channelId}>`,              inline: true },
              { name: "Sources", value: `${NEWS_SOURCES.length} official`,     inline: true },
              {
                name: "All Sources",
                value: NEWS_SOURCES.map(s => `${s.flag} ${s.name}`).join(" • "),
              },
            )
            .setFooter({ text: "Checks every 5 minutes — breaking news from official websites" });

          await interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error("[/news-alerts] Error:", error);
        const msg = { content: "An error occurred, please try again." };
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply(msg).catch(() => {});
        } else {
          await interaction.reply({ ...msg, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    },
  },
  // ─── /tv-news ──────────────────────────────────────────────────────────────
  // Entertainment news: Anime, International Film/TV, Korean Drama/Pop.
  // Official RSS sources — no API key, updates every 15 minutes.
  {
    name: "tv-news",
    guildId: null,
    definition: new SlashCommandBuilder()
      .setName("tv-news")
      .setDescription("Anime, international film/TV & Korean drama news from official RSS sources.")
      .addSubcommand(sub =>
        sub.setName("set")
          .setDescription("Set the channel where entertainment news will be posted.")
          .addChannelOption(o =>
            o.setName("channel")
             .setDescription("Text channel to receive TV & anime news")
             .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName("stop")
          .setDescription("Stop posting entertainment news in this server.")
      )
      .addSubcommand(sub =>
        sub.setName("status")
          .setDescription("Show current configuration and list of sources.")
      )
      .toJSON(),

    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({
            content: "❌ You need **Manage Channels** permission to use this command.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({ content: "This command can only be used in a server.", flags: MessageFlags.Ephemeral });
          return;
        }

        const sub = interaction.options.getSubcommand();

        // ── /tv-news set ──────────────────────────────────────────────────────
        if (sub === "set") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const channel = interaction.options.getChannel("channel", true) as any;

          if (!channel.isTextBased() || channel.isVoiceBased()) {
            await interaction.editReply({ content: `❌ <#${channel.id}> is not a text channel.` });
            return;
          }

          await setTVNewsChannel(guildId, channel.id);

          const animeSrcs = TV_SOURCES.filter(s => s.lang === "anime");
          const intlSrcs  = TV_SOURCES.filter(s => s.lang === "intl");
          const krSrcs    = TV_SOURCES.filter(s => s.lang === "kr");

          const embed = new EmbedBuilder()
            .setColor(0xE91E8C)
            .setTitle("📺 TV & Anime News Activated")
            .setDescription(`Anime, film & Korean drama news will be posted in <#${channel.id}> every **5 minutes**.`)
            .addFields(
              {
                name: "🎌 Anime / Japanese",
                value: animeSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🎬 Film & TV",
                value: intlSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🇰🇷 Korean",
                value: krSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
            )
            .setFooter({ text: `${TV_SOURCES.length} official sources — new seasons, releases & breaking news` });

          await interaction.editReply({ embeds: [embed] });

        // ── /tv-news stop ─────────────────────────────────────────────────────
        } else if (sub === "stop") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const stopped = await stopTVNews(guildId);
          await interaction.editReply({
            content: stopped
              ? "✅ TV & anime news have been stopped."
              : "⚠️ TV & anime news were not active.",
          });

        // ── /tv-news status ───────────────────────────────────────────────────
        } else if (sub === "status") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const config = await getTVNewsConfig(guildId);

          if (!config) {
            await interaction.editReply({
              content: "📭 TV news is not configured yet.\nUse `/tv-news set` to activate it.",
            });
            return;
          }

          const statusEmoji = config.enabled ? "✅ Active" : "⛔ Stopped";
          const embed = new EmbedBuilder()
            .setColor(config.enabled ? Colors.Green : Colors.Red)
            .setTitle("📺 TV & Anime News Status")
            .addFields(
              { name: "Status",  value: statusEmoji,                         inline: true },
              { name: "Channel", value: `<#${config.channelId}>`,            inline: true },
              { name: "Sources", value: `${TV_SOURCES.length} official`,     inline: true },
              {
                name: "🎌 Anime",
                value: TV_SOURCES.filter(s => s.lang === "anime").map(s => `${s.flag} ${s.name}`).join(" • "),
              },
              {
                name: "🎬 Film & TV",
                value: TV_SOURCES.filter(s => s.lang === "intl").map(s => `${s.flag} ${s.name}`).join(" • "),
              },
              {
                name: "🇰🇷 Korean",
                value: TV_SOURCES.filter(s => s.lang === "kr").map(s => `${s.flag} ${s.name}`).join(" • "),
              },
            )
            .setFooter({ text: "Checks every 5 minutes from official RSS feeds" });

          await interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error("[/tv-news] Error:", error);
        const msg = { content: "An error occurred, please try again." };
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
