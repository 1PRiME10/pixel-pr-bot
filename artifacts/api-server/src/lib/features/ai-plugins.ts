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
          .setDescription("Set channels per region — Arabic, International & Japanese separately.")
          .addChannelOption(o =>
            o.setName("arabic-channel")
             .setDescription("Channel for Arabic news (Al Jazeera, BBC Arabic, Sky News Arabia, RT Arabic)")
             .setRequired(false)
          )
          .addChannelOption(o =>
            o.setName("international-channel")
             .setDescription("Channel for international news (Reuters, BBC World, AP News)")
             .setRequired(false)
          )
          .addChannelOption(o =>
            o.setName("japanese-channel")
             .setDescription("Channel for Japanese news (NHK World, The Japan Times)")
             .setRequired(false)
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

          const arCh   = interaction.options.getChannel("arabic-channel")       as any ?? null;
          const enCh   = interaction.options.getChannel("international-channel") as any ?? null;
          const jaCh   = interaction.options.getChannel("japanese-channel")     as any ?? null;

          if (!arCh && !enCh && !jaCh) {
            await interaction.editReply({
              content: "❌ Please provide at least one channel (Arabic, International, or Japanese).",
            });
            return;
          }

          // Validate all provided channels are text channels
          for (const ch of [arCh, enCh, jaCh]) {
            if (ch && (!ch.isTextBased() || ch.isVoiceBased())) {
              await interaction.editReply({ content: `❌ <#${ch.id}> is not a text channel.` });
              return;
            }
          }

          await setNewsChannel(guildId, {
            ar: arCh?.id ?? undefined,
            en: enCh?.id ?? undefined,
            ja: jaCh?.id ?? undefined,
          });

          const arabicSources   = NEWS_SOURCES.filter(s => s.lang === "ar");
          const intlSources     = NEWS_SOURCES.filter(s => s.lang === "en");
          const japaneseSources = NEWS_SOURCES.filter(s => s.lang === "ja");

          const fields: { name: string; value: string; inline: boolean }[] = [];
          if (arCh) fields.push({
            name: "🌍 Arabic News → " + `#${arCh.name}`,
            value: arabicSources.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });
          if (enCh) fields.push({
            name: "🌐 International News → " + `#${enCh.name}`,
            value: intlSources.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });
          if (jaCh) fields.push({
            name: "🇯🇵 Japanese News → " + `#${jaCh.name}`,
            value: japaneseSources.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });

          const embed = new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("📰 News Alerts Configured")
            .setDescription("Breaking news will be posted every **5 minutes** to the channels below.")
            .addFields(...fields)
            .setFooter({ text: "Only configured categories will receive news." });

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
          const channelFields: { name: string; value: string; inline: boolean }[] = [
            { name: "Status",  value: statusEmoji, inline: false },
            { name: "🌍 Arabic Channel",        value: config.channelIdAr ? `<#${config.channelIdAr}>` : "Not set", inline: true },
            { name: "🌐 International Channel",  value: config.channelIdEn ? `<#${config.channelIdEn}>` : "Not set", inline: true },
            { name: "🇯🇵 Japanese Channel",      value: config.channelIdJa ? `<#${config.channelIdJa}>` : "Not set", inline: true },
          ];

          const embed = new EmbedBuilder()
            .setColor(config.enabled ? Colors.Green : Colors.Red)
            .setTitle("📰 News Alerts Status")
            .addFields(...channelFields)
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
          .setDescription("Set channels per category — Anime, Film/TV & Korean separately.")
          .addChannelOption(o =>
            o.setName("anime-channel")
             .setDescription("Channel for anime & manga news (MyAnimeList, Anime Corner, Otaku USA, Comic Natalie)")
             .setRequired(false)
          )
          .addChannelOption(o =>
            o.setName("film-channel")
             .setDescription("Channel for international film & TV news (Deadline, Variety, Collider, Screen Rant)")
             .setRequired(false)
          )
          .addChannelOption(o =>
            o.setName("korean-channel")
             .setDescription("Channel for Korean drama & K-pop news (Soompi, Dramabeans, Koreaboo)")
             .setRequired(false)
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

          const animeCh = interaction.options.getChannel("anime-channel")  as any ?? null;
          const filmCh  = interaction.options.getChannel("film-channel")   as any ?? null;
          const krCh    = interaction.options.getChannel("korean-channel") as any ?? null;

          if (!animeCh && !filmCh && !krCh) {
            await interaction.editReply({
              content: "❌ Please provide at least one channel (Anime, Film/TV, or Korean).",
            });
            return;
          }

          for (const ch of [animeCh, filmCh, krCh]) {
            if (ch && (!ch.isTextBased() || ch.isVoiceBased())) {
              await interaction.editReply({ content: `❌ <#${ch.id}> is not a text channel.` });
              return;
            }
          }

          await setTVNewsChannel(guildId, {
            anime: animeCh?.id ?? undefined,
            intl:  filmCh?.id  ?? undefined,
            kr:    krCh?.id    ?? undefined,
          });

          const animeSrcs = TV_SOURCES.filter(s => s.lang === "anime");
          const intlSrcs  = TV_SOURCES.filter(s => s.lang === "intl");
          const krSrcs    = TV_SOURCES.filter(s => s.lang === "kr");

          const fields: { name: string; value: string; inline: boolean }[] = [];
          if (animeCh) fields.push({
            name: `🎌 Anime & Manga → #${animeCh.name}`,
            value: animeSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });
          if (filmCh) fields.push({
            name: `🎬 Film & TV → #${filmCh.name}`,
            value: intlSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });
          if (krCh) fields.push({
            name: `🇰🇷 Korean → #${krCh.name}`,
            value: krSrcs.map(s => `${s.flag} ${s.name}`).join("\n"),
            inline: true,
          });

          const embed = new EmbedBuilder()
            .setColor(0xE91E8C)
            .setTitle("📺 TV & Anime News Configured")
            .setDescription("News will be posted every **5 minutes** to the channels below.")
            .addFields(...fields)
            .setFooter({ text: "Only configured categories will receive news." });

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
              { name: "Status", value: statusEmoji, inline: false },
              { name: "🎌 Anime Channel",   value: config.channelIdAnime ? `<#${config.channelIdAnime}>` : "Not set", inline: true },
              { name: "🎬 Film/TV Channel", value: config.channelIdIntl  ? `<#${config.channelIdIntl}>`  : "Not set", inline: true },
              { name: "🇰🇷 Korean Channel", value: config.channelIdKr    ? `<#${config.channelIdKr}>`    : "Not set", inline: true },
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
