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
             .setDescription("Text channel to receive news alerts")
             .setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub.setName("stop")
          .setDescription("Stop posting news alerts in this server.")
      )
      .addSubcommand(sub =>
        sub.setName("status")
          .setDescription("Show current news alerts configuration and sources.")
      )
      .toJSON(),

    handler: async (interaction: ChatInputCommandInteraction): Promise<void> => {
      try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.reply({
            content: "❌ تحتاج صلاحية **Manage Channels** لاستخدام هذا الأمر.",
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
            await interaction.editReply({ content: `❌ <#${channel.id}> ليست قناة نصية.` });
            return;
          }

          await setNewsChannel(guildId, channel.id);

          const arabicSources    = NEWS_SOURCES.filter(s => s.lang === "ar");
          const intlSources      = NEWS_SOURCES.filter(s => s.lang === "en");
          const japaneseSources  = NEWS_SOURCES.filter(s => s.lang === "ja");

          const embed = new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle("📰 تم تفعيل الأخبار العاجلة")
            .setDescription(`سيتم نشر الأخبار في <#${channel.id}> كل **15 دقيقة** تلقائياً.`)
            .addFields(
              {
                name: "🌍 المصادر العربية",
                value: arabicSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🌐 المصادر الدولية",
                value: intlSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
              {
                name: "🇯🇵 المصادر اليابانية",
                value: japaneseSources.map(s => `${s.flag} ${s.name}`).join("\n"),
                inline: true,
              },
            )
            .setFooter({ text: "أخبار مباشرة من المصادر الرسمية — بدون Twitter" });

          await interaction.editReply({ embeds: [embed] });

        // ── /news-alerts stop ─────────────────────────────────────────────────
        } else if (sub === "stop") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const stopped = await stopNewsAlerts(guildId);
          if (stopped) {
            await interaction.editReply({ content: "✅ تم إيقاف تنبيهات الأخبار لهذا السيرفر." });
          } else {
            await interaction.editReply({ content: "⚠️ لم تكن تنبيهات الأخبار مفعّلة." });
          }

        // ── /news-alerts status ───────────────────────────────────────────────
        } else if (sub === "status") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const config = await getNewsConfig(guildId);

          if (!config) {
            await interaction.editReply({
              content: "📭 لم يتم إعداد تنبيهات الأخبار بعد.\nاستخدم `/news-alerts set` لتفعيلها.",
            });
            return;
          }

          const statusEmoji = config.enabled ? "✅ مفعّل" : "⛔ موقوف";
          const embed = new EmbedBuilder()
            .setColor(config.enabled ? Colors.Green : Colors.Red)
            .setTitle("📰 حالة تنبيهات الأخبار")
            .addFields(
              { name: "الحالة",   value: statusEmoji,            inline: true },
              { name: "القناة",   value: `<#${config.channelId}>`, inline: true },
              { name: "عدد المصادر", value: `${NEWS_SOURCES.length} مصدر رسمي`, inline: true },
              {
                name: "المصادر",
                value: NEWS_SOURCES.map(s => `${s.flag} ${s.name}`).join(" • "),
              },
            )
            .setFooter({ text: "يتحقق كل 15 دقيقة — أخبار عاجلة مباشرة من المواقع الرسمية" });

          await interaction.editReply({ embeds: [embed] });
        }

      } catch (error) {
        console.error("[/news-alerts] Error:", error);
        const msg = { content: "حدث خطأ، يرجى المحاولة مجدداً." };
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
