// ─── Slash Commands — Auto-registration + Interaction Handler ─────────────────
// Registers all bot commands as Discord slash commands so they appear in the
// bot profile. Handlers delegate to the same underlying logic as prefix cmds.
//
// Called from initBot():
//   registerSlashCommands(client, token)  — registers on "ready" and handles interactions

import {
  Client,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
  VoiceChannel,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { createHash } from "crypto";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";
import { generateImage } from "@workspace/integrations-gemini-ai/image";
import { db, reputationTable, pool } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { askPixel, clearHistory, clearGuildHistory } from "../discord-bot.js";
import { tryClaimInteraction, tryClaimGuildEvent } from "../message-dedup.js";
import {
  getPersonaName,
  setPersona,
  clearPersona,
  PERSONA_PRESETS,
} from "./persona.js";
import { clearMemory } from "./memory.js";
import { getWarnings, addWarningAndCheck, clearWarnings } from "./moderation.js";
import { pickEmoji, parseEmotion, getExpressionImagePath } from "./ai-hoshino-emojis.js";
import { addTwitterAccount, removeTwitterAccount, listTwitterAccounts, resetAllTwitterAccounts, advanceAllTwitterAccounts, cleanUsername, FAILURE_THRESHOLD } from "./tweet-monitor.js";
import {
  addYouTubeChannel, removeYouTubeChannel, listYouTubeChannels,
  resolveYTChannelId, findYTChannelByName, fetchLatestVideos as fetchYTVideos,
} from "./youtube-monitor.js";
import {
  setWelcomeChannel, setWelcomeMsg, clearWelcomeConfig,
  getWelcomeChannelId, getWelcomeMessage, sendWelcomeEmbed,
} from "./welcome.js";
import { jpConfigs, saveJPConfig } from "./jp-tracker.js";
import { logChannels } from "./auto-security.js";
import {
  BUILTIN_STATIONS, radioStates, searchRadioBrowser,
  stopRadio, saveRadioConfig, startRadio, resetStreamFailCount, RBStation, RadioState,
} from "./radio.js";
import { serverLogChannels } from "./server-log.js";
import {
  generateProfileReport, loadProfile, flushPending,
  peakHours, reportChannels, setReportChannel,
} from "./profiling.js";
import { generateBriefing, setReportChannelId } from "./sentiment.js";
import { hasConsented, acceptConsent, getPrivacyNotice } from "./consent.js";
import { handleFeatureCommand, FEATURE_REGISTRY, setFeatureEnabled, isBotOwner } from "../feature-registry.js";
import { searchAndTrackTitle, anilistCountdown } from "./tracker.js";
import { startWordChain, stopWordChain } from "./games.js";
import { hideInImage, revealFromImage } from "./steganography.js";
import {
  createEvent, listEvents, getEvent, deleteEvent, editEvent,
  buildEventEmbed, parseEventDate, EventType, RecurType,
} from "./events.js";
import { removeChatChannel, addChatChannel } from "./chat-channels.js";
import {
  handleError as selfHealError,
  setHealthChannel,
  getHealthStatus,
  buildHealthEmbed,
  getRecentErrors,
  getCachedFix,
} from "./self-heal.js";
import { setAutoFixEnabled, autoFixEnabled, getFixHistory, applyManualFix } from "./auto-fix.js";
import { aiPluginCommands } from "./ai-plugins.js";
import {
  checkRateLimit, sanitizeCommandOption,
  runSecurityScan, hardenSecurity, getSecurityStatus,
} from "./security-hardening.js";
import { initRegistrar } from "../plugin-registrar.js";
import {
  activateVoiceAI, deactivateVoiceAI, voiceAIStates,
  setVoiceAIChannel, removeVoiceAIChannel, getVoiceAIChannel,
} from "./voice-ai.js";
import { fetchLatestTweets, buildTweetEmbed, buildTweetButton, cleanUsername, cacheTwitterUserId } from "./tweet-monitor.js";
import { setJokeChannel, removeJokeChannel, getJokeScheduleChannel, generateAndSendJoke } from "./joke-scheduler.js";

const REP_COOLDOWN_MS = 24 * 60 * 60 * 1000;


// ─── Command Definitions ──────────────────────────────────────────────────────
const commands = [
  // ── Utility ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all bot commands"),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar")
    .addUserOption(o => o.setName("user").setDescription("User to show avatar for").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show server statistics"),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show user info and warnings")
    .addUserOption(o => o.setName("user").setDescription("User to inspect").setRequired(false)),

  // ── AI ───────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("pixel")
    .setDescription("Chat with PIXEL AI (remembers you!)")
    .addStringOption(o => o.setName("question").setDescription("What do you want to ask?").setRequired(true)),

  new SlashCommandBuilder()
    .setName("search")
    .setDescription("Get an AI summary of any topic")
    .addStringOption(o => o.setName("topic").setDescription("Topic to search").setRequired(true)),

  new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Generate an AI image")
    .addStringOption(o => o.setName("description").setDescription("What to generate").setRequired(true)),

  new SlashCommandBuilder()
    .setName("aesthetic")
    .setDescription("✨ Japanese translation + decorative fonts + hashtags")
    .addStringOption(o => o.setName("text").setDescription("Text to aestheticify").setRequired(true)),

  new SlashCommandBuilder()
    .setName("summary")
    .setDescription("Summarize the last 50 messages in this channel"),

  new SlashCommandBuilder()
    .setName("forget")
    .setDescription("Clear your conversation history and long-term memory"),

  // ── Persona ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("persona")
    .setDescription("Manage PIXEL's character persona")
    .addSubcommand(s => s.setName("show").setDescription("View current persona"))
    .addSubcommand(s => s.setName("presets").setDescription("List all built-in characters"))
    .addSubcommand(s =>
      s.setName("preset")
        .setDescription("Activate a built-in character (Admin)")
        .addStringOption(o =>
          o.setName("key")
            .setDescription("Preset key (ai, zero_two, aqua, holo)")
            .setRequired(true)
            .addChoices(
              { name: "⭐ Ai Hoshino (Oshi no Ko)", value: "ai" },
              { name: "🌸 Zero Two (Darling in the FranXX)", value: "zero_two" },
              { name: "💙 Aqua Hoshino (Oshi no Ko)", value: "aqua" },
              { name: "🐺 Holo the Wise Wolf (Spice and Wolf)", value: "holo" },
            )
        )
    )
    .addSubcommand(s =>
      s.setName("set")
        .setDescription("Set a custom character (Admin)")
        .addStringOption(o => o.setName("name").setDescription("Character name").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("Personality description (at least 20 chars)").setRequired(true))
    )
    .addSubcommand(s => s.setName("clear").setDescription("Reset back to PIXEL (Admin)")),

  // ── Reputation ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("giverep")
    .setDescription("Give reputation to a user (once per 24h)")
    .addUserOption(o => o.setName("user").setDescription("User to give rep to").setRequired(true)),

  new SlashCommandBuilder()
    .setName("rep")
    .setDescription("Check a user's reputation")
    .addUserOption(o => o.setName("user").setDescription("User to check (default: yourself)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show top 10 reputation leaderboard"),

  // ── Games ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("wyr")
    .setDescription("Generate a Would You Rather question"),

  new SlashCommandBuilder()
    .setName("wordchain")
    .setDescription("Start a word chain game in this channel"),

  new SlashCommandBuilder()
    .setName("stopchain")
    .setDescription("Stop the current word chain game"),

  // ── JP Radar ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("jptime")
    .setDescription("Current Tokyo time + vibe label"),

  new SlashCommandBuilder()
    .setName("jpairing")
    .setDescription("What's airing in Japan RIGHT NOW"),

  // ── Moderation (Admin) ────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member to ban").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Timeout (mute) a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member to mute").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes (default: 10)").setRequired(false))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove timeout from a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member to unmute").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View warnings for a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(false)),

  new SlashCommandBuilder()
    .setName("clearwarns")
    .setDescription("Clear all warnings for a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to clear warnings for").setRequired(true)),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set slowmode on this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName("seconds").setDescription("Seconds (0 to disable)").setRequired(false)),

  // ── Radio ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("radiostatus")
    .setDescription("Show current radio info"),

  new SlashCommandBuilder()
    .setName("stations")
    .setDescription("List all available radio stations"),

  new SlashCommandBuilder()
    .setName("radiostop")
    .setDescription("Stop the radio")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("setradio")
    .setDescription("Configure radio: set voice + text channels (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption(o => o.setName("voice").setDescription("Voice channel to play radio in").setRequired(true).addChannelTypes(ChannelType.GuildVoice))
    .addChannelOption(o => o.setName("text").setDescription("Text channel for radio notifications (default: current)").setRequired(false).addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName("station").setDescription("Built-in key (lofi, jazz, bbc, aljazeera, skynews, mcd, bbcarabic, alarabiya, nhk…)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("radioplay")
    .setDescription("Start/resume the radio"),

  new SlashCommandBuilder()
    .setName("radiopause")
    .setDescription("Pause the radio"),

  new SlashCommandBuilder()
    .setName("radiostation")
    .setDescription("Switch to a built-in station by key")
    .addStringOption(o => o.setName("key").setDescription("Station key — use /stations to see all keys (lofi, bbcarabic, aljazeera, nhk …)").setRequired(true)),

  new SlashCommandBuilder()
    .setName("streamurl")
    .setDescription("Play any direct stream URL (MP3 / AAC / HLS / Opus)")
    .addStringOption(o => o.setName("url").setDescription("Full stream URL starting with https://").setRequired(true))
    .addStringOption(o => o.setName("name").setDescription("Display name for the station (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("radiosearch")
    .setDescription("Search Radio Browser and start playing a result")
    .addStringOption(o => o.setName("query").setDescription("Station name to search for").setRequired(true)),

  // ── Twitter/X Monitor (Admin) ─────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("addtwitter")
    .setDescription("Monitor a Twitter/X account — new posts sent to a channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("username").setDescription("Twitter username (without @)").setRequired(true))
    .addChannelOption(o => o.setName("channel").setDescription("Text channel to send tweets to").setRequired(true).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("removetwitter")
    .setDescription("Stop monitoring a Twitter/X account (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("username").setDescription("Twitter username to remove").setRequired(true)),

  new SlashCommandBuilder()
    .setName("twitterlist")
    .setDescription("List all monitored Twitter/X accounts (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── YouTube Monitor (Admin) ───────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("addyoutube")
    .setDescription("Monitor a YouTube channel — new videos sent automatically to a channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("channel_url")
        .setDescription("YouTube channel URL, @handle, or channel ID  (e.g. @MrBeast)")
        .setRequired(true))
    .addChannelOption(o =>
      o.setName("discord_channel")
        .setDescription("Discord text channel to send new videos to")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("removeyoutube")
    .setDescription("Stop monitoring a YouTube channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("channel_url")
        .setDescription("YouTube @handle, channel ID, or channel name to remove")
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName("youtubelist")
    .setDescription("List all monitored YouTube channels in this server (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Welcome ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setwelcome")
    .setDescription("Set the welcome channel for new members (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel (default: current)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("setwelcomemsg")
    .setDescription("Set a custom welcome message — use {user} and {server} (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("message").setDescription("Welcome text — use {user} and {server}").setRequired(true)),

  new SlashCommandBuilder()
    .setName("removewelcome")
    .setDescription("Remove the welcome channel config (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("testwelcome")
    .setDescription("Preview the welcome message in the configured channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── JP Tracker setup ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setjpchannel")
    .setDescription("Set the channel for JP Radar events (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for JP Radar alerts (default: current)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("jpalerts")
    .setDescription("Toggle hourly JP Radar alerts on/off (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("state").setDescription("on or off").setRequired(true).addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),

  // ── Server Log ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setserverlog")
    .setDescription("Set the server log channel for message edits/deletes (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel (default: current)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("removeserverlog")
    .setDescription("Remove server log channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Auto-Security ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("setlog")
    .setDescription("Set the security alert log channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel (default: current)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("removelog")
    .setDescription("Remove the security alert log channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("securitystatus")
    .setDescription("Show current auto-security settings (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Steganography ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("hide")
    .setDescription("Hide a secret message inside an attached PNG image")
    .addStringOption(o => o.setName("message").setDescription("Secret message to hide").setRequired(true))
    .addAttachmentOption(o => o.setName("image").setDescription("PNG image to hide the message in").setRequired(true))
    .addStringOption(o => o.setName("key").setDescription("Optional encryption key").setRequired(false)),

  new SlashCommandBuilder()
    .setName("reveal")
    .setDescription("Reveal a hidden message from an attached image")
    .addAttachmentOption(o => o.setName("image").setDescription("Image to scan").setRequired(true))
    .addStringOption(o => o.setName("key").setDescription("Decryption key (if used during hide)").setRequired(false)),

  // ── Profiling ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Generate a behavioural report for a user (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to profile").setRequired(true)),

  new SlashCommandBuilder()
    .setName("myprofile")
    .setDescription("View your own activity stats in this server"),

  new SlashCommandBuilder()
    .setName("setprofilechannel")
    .setDescription("Set or disable the profile report log channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for report logs (omit to disable)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  // ── Sentiment / Briefing ──────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("briefing")
    .setDescription("Get an instant AI server activity report (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("setreport")
    .setDescription("Set the channel for daily AI briefing reports (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for daily briefings (omit to disable)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  // ── Topic Tracker ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("trackchannel")
    .setDescription("Set the channel for anime/manga release notifications (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Text channel for notifications (omit to show current)").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("track")
    .setDescription("Track an anime or manga for release notifications")
    .addStringOption(o => o.setName("type").setDescription("anime or manga").setRequired(true).addChoices({ name: "🎬 Anime", value: "anime" }, { name: "📖 Manga", value: "manga" }))
    .addStringOption(o => o.setName("name").setDescription("Title to track").setRequired(true)),

  new SlashCommandBuilder()
    .setName("untrack")
    .setDescription("Stop tracking an anime or manga")
    .addStringOption(o => o.setName("name").setDescription("Title to untrack").setRequired(true)),

  new SlashCommandBuilder()
    .setName("tracklist")
    .setDescription("List all tracked anime and manga titles"),

  new SlashCommandBuilder()
    .setName("countdown")
    .setDescription("Show the countdown to the next episode of a tracked anime")
    .addStringOption(o => o.setName("name").setDescription("Anime name").setRequired(true)),

  // ── Privacy / Consent ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("privacy")
    .setDescription("View PIXEL's privacy policy and data collection notice"),

  new SlashCommandBuilder()
    .setName("accept")
    .setDescription("Accept the privacy notice to enable behavioural profiling for yourself"),

  // ── Utility (missing) ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make PIXEL send a message in this channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("text").setDescription("Message to send").setRequired(true)),

  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Add or remove a role from a member (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addUserOption(o => o.setName("user").setDescription("Member to modify").setRequired(true))
    .addRoleOption(o => o.setName("role").setDescription("Role to add/remove").setRequired(true)),

  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Toggle AI auto-chat in this channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("state").setDescription("on or off").setRequired(true).addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),

  new SlashCommandBuilder()
    .setName("feature")
    .setDescription("Enable or disable a bot feature (Admin/Owner)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("name").setDescription("Feature key (e.g. ai, radio, games, daily)").setRequired(true))
    .addStringOption(o => o.setName("state").setDescription("on or off").setRequired(true).addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Set or show the daily inspiration channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o => o.setName("channel").setDescription("Channel for daily inspiration messages").setRequired(false).addChannelTypes(ChannelType.GuildText)),

  // ── Clear chat (AI memory) — standalone admin tool ────────────────────────
  new SlashCommandBuilder()
    .setName("clearchat")
    .setDescription("Clear PIXEL's AI memory and/or delete bot messages from this channel (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("scope")
        .setDescription("AI memory scope to clear (default: this channel)")
        .setRequired(false)
        .addChoices(
          { name: "🔄 Channel — clear AI memory for this channel",    value: "channel" },
          { name: "👤 User — clear a specific user's AI memory",      value: "user"    },
          { name: "🌐 Guild — clear ALL AI memory for this server",   value: "guild"   },
          { name: "🚫 None — only delete messages, skip AI memory",   value: "none"    },
        ))
    .addBooleanOption(o =>
      o.setName("delete_messages")
        .setDescription("Also delete PIXEL's actual messages from this channel?")
        .setRequired(false))
    .addIntegerOption(o =>
      o.setName("limit")
        .setDescription("Max bot messages to delete (default: 100, max: 500) — only used with delete_messages")
        .setMinValue(1)
        .setMaxValue(500)
        .setRequired(false))
    .addUserOption(o => o.setName("user").setDescription("User to clear (only with scope: user)").setRequired(false)),

  // ── Events / Reminders ────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Manage scheduled events and automatic reminders")
    .addSubcommand(s =>
      s.setName("create")
        .setDescription("Create a new event with automatic reminders")
        .addStringOption(o => o.setName("title").setDescription("Event title").setRequired(true))
        .addStringOption(o => o.setName("datetime").setDescription("Date & time: YYYY-MM-DD HH:MM  or  DD/MM/YYYY HH:MM").setRequired(true))
        .addStringOption(o => o.setName("description").setDescription("Event description (optional)").setRequired(false))
        .addChannelOption(o => o.setName("channel").setDescription("Channel for reminders (default: this channel)").setRequired(false).addChannelTypes(ChannelType.GuildText))
        .addStringOption(o =>
          o.setName("type")
            .setDescription("Event type")
            .setRequired(false)
            .addChoices(
              { name: "📅 Event",       value: "event"      },
              { name: "🎮 Game",        value: "game"       },
              { name: "🏆 Tournament",  value: "tournament" },
              { name: "📺 Watch Party", value: "watch"      },
              { name: "📌 Other",       value: "other"      },
            ))
        .addStringOption(o =>
          o.setName("recurring")
            .setDescription("Repeat schedule")
            .setRequired(false)
            .addChoices(
              { name: "❌ No repeat (default)", value: "none"    },
              { name: "📆 Daily",               value: "daily"   },
              { name: "📅 Weekly",              value: "weekly"  },
              { name: "🗓️ Monthly",             value: "monthly" },
            ))
        .addRoleOption(o => o.setName("role").setDescription("Role to ping in reminders (optional)").setRequired(false))
        .addStringOption(o => o.setName("banner").setDescription("Banner image URL for the embed (optional)").setRequired(false)))
    .addSubcommand(s =>
      s.setName("list")
        .setDescription("Show all upcoming events in this server")
        .addIntegerOption(o => o.setName("page").setDescription("Page number (default: 1)").setRequired(false)))
    .addSubcommand(s =>
      s.setName("info")
        .setDescription("View full details of an event")
        .addIntegerOption(o => o.setName("id").setDescription("Event ID (from /event list)").setRequired(true)))
    .addSubcommand(s =>
      s.setName("delete")
        .setDescription("Delete an event (Admin or creator)")
        .addIntegerOption(o => o.setName("id").setDescription("Event ID to delete").setRequired(true)))
    .addSubcommand(s =>
      s.setName("edit")
        .setDescription("Edit an existing event (Admin or creator)")
        .addIntegerOption(o => o.setName("id").setDescription("Event ID to edit").setRequired(true))
        .addStringOption(o => o.setName("title").setDescription("New title").setRequired(false))
        .addStringOption(o => o.setName("description").setDescription("New description").setRequired(false))
        .addStringOption(o => o.setName("datetime").setDescription("New date & time: YYYY-MM-DD HH:MM").setRequired(false))
        .addChannelOption(o => o.setName("channel").setDescription("New channel").setRequired(false).addChannelTypes(ChannelType.GuildText))
        .addRoleOption(o => o.setName("role").setDescription("New ping role").setRequired(false))
        .addStringOption(o =>
          o.setName("type")
            .setDescription("New type")
            .setRequired(false)
            .addChoices(
              { name: "📅 Event", value: "event" }, { name: "🎮 Game", value: "game" },
              { name: "🏆 Tournament", value: "tournament" }, { name: "📺 Watch Party", value: "watch" },
              { name: "📌 Other", value: "other" },
            ))
        .addStringOption(o =>
          o.setName("recurring")
            .setDescription("New repeat schedule")
            .setRequired(false)
            .addChoices(
              { name: "❌ No repeat", value: "none" }, { name: "📆 Daily", value: "daily" },
              { name: "📅 Weekly", value: "weekly" }, { name: "🗓️ Monthly", value: "monthly" },
            ))),

  // ── Self-Heal / System Health ──────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("health")
    .setDescription("Show the bot system health dashboard")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("sethealthchannel")
    .setDescription("Set the channel where the bot reports errors and health updates (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(o =>
      o.setName("channel")
        .setDescription("Channel for auto-reports (leave empty to disable)")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)),

  new SlashCommandBuilder()
    .setName("errors")
    .setDescription("Show recent bot errors and their AI analysis (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(o =>
      o.setName("limit")
        .setDescription("How many recent errors to show (default 5, max 10)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)),

  new SlashCommandBuilder()
    .setName("autofix")
    .setDescription("Control the AI auto-fix engine that patches and rebuilds the bot automatically (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("enable")
        .setDescription("Enable auto-fix: bot will patch its own code and restart when errors repeat"))
    .addSubcommand(s =>
      s.setName("disable")
        .setDescription("Disable auto-fix: errors are reported but no code changes are made"))
    .addSubcommand(s =>
      s.setName("status")
        .setDescription("Show current auto-fix status and recent fix history")),

  // ── /security ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("security")
    .setDescription("Security tools — scan for vulnerabilities and harden the bot (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("scan")
        .setDescription("Scan all source files for security vulnerabilities using Gemini AI"))
    .addSubcommand(s =>
      s.setName("harden")
        .setDescription("Apply AI-generated security fixes to found vulnerabilities automatically"))
    .addSubcommand(s =>
      s.setName("status")
        .setDescription("Show security scan results and harden status")),

  new SlashCommandBuilder()
    .setName("resetplugins")
    .setDescription("Remove ALL AI-built commands from this server and restore default state (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("plugins")
    .setDescription("Show all AI-built commands in this server — status, description, and test buttons (admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Twitter manual poll (Admin only) ──────────────────────────────────────
  new SlashCommandBuilder()
    .setName("twitterpoll")
    .setDescription("Manually check a monitored Twitter/X account right now and show debug info (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName("username")
       .setDescription("Twitter username (without @)")
       .setRequired(true)),

  // ── Twitter reset all failures (Admin only) ────────────────────────────────
  new SlashCommandBuilder()
    .setName("twitterreset")
    .setDescription("Reset all failing Twitter/X accounts and force them to retry immediately (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Twitter advance — sync last_tweet_id to actual latest (Admin only) ────
  new SlashCommandBuilder()
    .setName("twitteradvance")
    .setDescription("Sync all accounts to current latest tweet — prevents old-tweet floods (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Joke auto-scheduler (Admin only) ──────────────────────────────────────
  new SlashCommandBuilder()
    .setName("jokeschedule")
    .setDescription("Auto-post 5 anime jokes per day to a channel (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("set")
       .setDescription("Set the channel for daily auto-jokes")
       .addChannelOption(o =>
         o.setName("channel")
          .setDescription("The text channel to post jokes in")
          .setRequired(true)))
    .addSubcommand(s =>
      s.setName("off")
       .setDescription("Stop auto-posting jokes"))
    .addSubcommand(s =>
      s.setName("status")
       .setDescription("Check which channel jokes are being posted to")),

  // ── Voice AI text-channel config (Admin only) ─────────────────────────────
  new SlashCommandBuilder()
    .setName("setvoicechannel")
    .setDescription("Set the text channel where Voice AI transcripts and replies are posted (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("set")
       .setDescription("Set the text channel for Voice AI")
       .addChannelOption(o =>
         o.setName("channel")
          .setDescription("The text channel to receive voice transcripts & AI replies")
          .setRequired(true)))
    .addSubcommand(s =>
      s.setName("clear")
       .setDescription("Remove the saved channel (Voice AI will use whichever channel /voicechat on is run in)"))
    .addSubcommand(s =>
      s.setName("status")
       .setDescription("Show the currently configured Voice AI text channel")),

  // ── Voice AI (Admin only) ─────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("voicechat")
    .setDescription("Voice AI — PIXEL listens in voice and responds aloud (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s =>
      s.setName("on")
       .setDescription("Join your current voice channel and start listening"))
    .addSubcommand(s =>
      s.setName("off")
       .setDescription("Stop listening and leave the voice channel"))
    .addSubcommand(s =>
      s.setName("status")
       .setDescription("Check if Voice AI is currently active")),

].map(c => c.toJSON());

// ─── Command hash helper — skip REST registration if nothing changed ───────────
async function getStoredCmdHash(): Promise<string | null> {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS slash_cmd_hash (
      id    TEXT PRIMARY KEY DEFAULT 'global',
      hash  TEXT NOT NULL,
      ts    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await pool.query(`SELECT hash FROM slash_cmd_hash WHERE id = 'global'`);
    return rows[0]?.hash ?? null;
  } catch { return null; }
}

async function storeCmdHash(hash: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO slash_cmd_hash (id, hash, ts) VALUES ('global', $1, NOW())
       ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash, ts = NOW()`,
      [hash],
    );
  } catch {}
}

function buildCmdHash(allCommands: unknown[]): string {
  const names = (allCommands as { name: string }[]).map(c => c.name).sort().join(",");
  return createHash("sha1").update(`${allCommands.length}:${names}`).digest("hex").slice(0, 12);
}

// ─── Register slash commands via REST ─────────────────────────────────────────
async function registerGlobalCommands(clientId: string, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    // ── Global registration: static commands + plugins with guildId: null ─────
    const globalPlugins = aiPluginCommands.filter(p => !p.guildId);
    const allCommands   = [...commands, ...globalPlugins.map(p => p.definition)];

    // Skip REST call if commands haven't changed since last registration
    const newHash    = buildCmdHash(allCommands);
    const storedHash = await getStoredCmdHash();
    if (storedHash === newHash) {
      console.log(`[Slash] ⚡ Commands unchanged (hash ${newHash}) — skipping REST registration`);
      initRegistrar(
        token, clientId,
        commands as unknown as Record<string, unknown>[],
        globalPlugins.map(p => p.definition) as unknown as Record<string, unknown>[],
      );
      return;
    }

    console.log(`[Slash] Registering ${commands.length} static + ${globalPlugins.length} AI plugin commands...`);
    await rest.put(Routes.applicationCommands(clientId), { body: allCommands });
    await storeCmdHash(newHash);
    console.log(`[Slash] ✅ Registered ${allCommands.length} global slash commands (${globalPlugins.length} AI-built)`);

    // ── Guild-specific registration: plugins with a guildId ───────────────────
    const guildPlugins = aiPluginCommands.filter(p => !!p.guildId);
    if (guildPlugins.length > 0) {
      // Group by guildId
      const byGuild = new Map<string, typeof guildPlugins>();
      for (const p of guildPlugins) {
        const g = p.guildId!;
        if (!byGuild.has(g)) byGuild.set(g, []);
        byGuild.get(g)!.push(p);
      }
      for (const [guildId, plugins] of byGuild.entries()) {
        try {
          // Merge with existing guild commands (avoid wiping manual guild commands)
          const existing = await rest.get(Routes.applicationGuildCommands(clientId, guildId)) as Record<string, unknown>[];
          const newNames  = new Set(plugins.map(p => p.name));
          const merged    = [...existing.filter(c => !newNames.has(c.name as string)), ...plugins.map(p => p.definition)];
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: merged });
          console.log(`[Slash] ✅ Registered ${plugins.length} guild command(s) for guild ${guildId}`);
        } catch (gErr) {
          console.warn(`[Slash] ⚠️ Could not register guild commands for ${guildId}:`, gErr);
        }
      }
    }

    // Initialise hot-registrar so /build can push new commands without restart
    initRegistrar(
      token, clientId,
      commands as unknown as Record<string, unknown>[],
      globalPlugins.map(p => p.definition) as unknown as Record<string, unknown>[],
    );
  } catch (err) {
    console.error("[Slash] Failed to register commands:", err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function replyAI(
  interaction: ChatInputCommandInteraction,
  rawAnswer: string,
): Promise<void> {
  const { emotion, clean } = parseEmotion(rawAnswer);
  const guildId  = interaction.guildId ?? undefined;
  const emoji    = emotion ? pickEmoji(emotion, guildId) + " " : "";
  const full     = emoji + clean;
  const chunks   = full.match(/[\s\S]{1,1900}/g) ?? [full];

  // Attach chibi expression image if available (works for both normal + persona)
  const imgPath = emotion ? getExpressionImagePath(emotion) : null;
  if (imgPath) {
    const attachment = new AttachmentBuilder(imgPath, { name: `ai_${emotion}.png` });
    await interaction.editReply({ content: chunks[0], files: [attachment] });
  } else {
    await interaction.editReply(chunks[0]);
  }
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

// ─── Plugin Test Runner ───────────────────────────────────────────────────────
// Executes a plugin handler with a safe mock interaction to validate it works.
// Uses realistic defaults so the handler can run its full logic path.
async function runPluginTest(
  pluginName: string,
  ctx: { guildId: string | null; user: any; member: any; guild: any; channel: any; channelId: string },
): Promise<{ pass: boolean; output?: string; error?: string }> {
  const plugin = aiPluginCommands.find(p => p.name === pluginName);
  if (!plugin) return { pass: false, error: `Plugin '/${pluginName}' not found in registry.` };

  let captured = "";
  const captureContent = (content: any): string => {
    if (typeof content === "string") return content.slice(0, 300);
    if (content?.content) return String(content.content).slice(0, 300);
    if (content?.embeds?.length) {
      const e = content.embeds[0];
      const d = e?.data ?? e;
      return `[Embed: "${d?.title ?? "(no title)"}"]`;
    }
    return "(complex response)";
  };

  const mockInteraction = {
    guildId:     ctx.guildId,
    user:        ctx.user,
    member:      ctx.member,
    guild:       ctx.guild,
    channel:     ctx.channel,
    channelId:   ctx.channelId,
    inGuild:     () => !!ctx.guildId,
    isChatInputCommand: () => true,
    commandName: pluginName,
    options: {
      getString:          (_: string, __?: boolean) => "test",
      getInteger:         (_: string, __?: boolean) => 1,
      getNumber:          (_: string, __?: boolean) => 1.0,
      getBoolean:         (_: string, __?: boolean) => false,
      getUser:            (_: string, __?: boolean) => ctx.user,
      getMember:          (_: string, __?: boolean) => ctx.member,
      getChannel:         (_: string, __?: boolean) => ctx.channel,
      getRole:            (_: string, __?: boolean) => null,
      getAttachment:      (_: string, __?: boolean) => null,
      getSubcommand:      (_?: boolean) => "test",
      getSubcommandGroup: (_?: boolean) => null,
      resolved: { users: new Map(), members: new Map(), channels: new Map(), roles: new Map() },
    },
    deferReply:  async (_?: any) => {},
    reply:       async (content: any) => { captured = captureContent(content); },
    editReply:   async (content: any) => { captured = captureContent(content); },
    followUp:    async (content: any) => { captured += (captured ? "\n" : "") + captureContent(content); },
    fetchReply:  async () => null,
    deleteReply: async () => {},
  } as unknown as ChatInputCommandInteraction;

  try {
    await plugin.handler(mockInteraction);
    return {
      pass: true,
      output: captured || "(handler ran — uses deferred/async pattern, no captured output)",
    };
  } catch (err: any) {
    return { pass: false, error: String(err?.message ?? err).slice(0, 500) };
  }
}


// ─── Station resolver with fuzzy matching ─────────────────────────────────────
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function resolveStation(input: string): { key: string; station: (typeof BUILTIN_STATIONS)[string]; suggestion?: boolean } | null {
  const raw = input.trim();
  // 1. Exact match
  if (BUILTIN_STATIONS[raw]) return { key: raw, station: BUILTIN_STATIONS[raw] };
  // 2. Case-insensitive exact
  const lower = raw.toLowerCase();
  for (const [k, v] of Object.entries(BUILTIN_STATIONS))
    if (k.toLowerCase() === lower) return { key: k, station: v };
  // 3. Fuzzy: pick closest key by edit distance (accept if within 2 edits)
  let bestKey = "";
  let bestDist = Infinity;
  for (const k of Object.keys(BUILTIN_STATIONS)) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) { bestDist = d; bestKey = k; }
  }
  const threshold = Math.max(1, Math.floor(bestKey.length / 4));
  if (bestDist <= threshold) return { key: bestKey, station: BUILTIN_STATIONS[bestKey], suggestion: true };
  return null;
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
function handleInteractions(client: Client): void {


  client.on(Events.InteractionCreate, async (interaction) => {
    // ── Button: open the pre-filled fix modal ──────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("sh_apply:")) {
      if (!isBotOwner(interaction.user.id)) {
        await interaction.reply({ content: "🔒 **Access denied.** Only the bot owner can use this.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const fixId = interaction.customId.split(":")[1];

      // Helper: build and show the modal from fix data (context, suggestion, target_file)
      const showFixModal = async (data: { context: string; suggestion: string; target_file: string }) => {
        const modal = new ModalBuilder()
          .setCustomId(`sh_modal:${fixId}`)
          .setTitle("🔧 Apply AI Fix");
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("target")
              .setLabel("Target file (e.g. slash-commands.ts)")
              .setStyle(TextInputStyle.Short)
              .setValue(data.target_file)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("description")
              .setLabel("Fix description (edit if needed)")
              .setStyle(TextInputStyle.Paragraph)
              .setValue(data.suggestion.slice(0, 4000))
              .setRequired(true),
          ),
        );
        await interaction.showModal(modal);
      };

      // ── Fast path: in-memory cache (instant — no DB wait, no 3s window risk) ──
      const cached = getCachedFix(fixId);
      if (cached) {
        try { await showFixModal(cached); } catch (e) {
          console.error("[SelfHeal-Button] Modal error (cache path):", e);
          await interaction.reply({ content: "❌ Error opening fix dialog.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return;
      }

      // ── Slow path: bot restarted → try DB with 2s timeout race ────────────────
      // Must acknowledge within 3s; cap DB wait at 2s to leave margin.
      let fixRow: any = null;
      let dbTimedOut = false;
      try {
        const dbPromise = pool.query(
          "SELECT context, suggestion, target_file FROM self_heal_pending_fixes WHERE id = $1",
          [fixId],
        );
        const timeoutPromise = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("db_timeout")), 2000),
        );
        const { rows } = await Promise.race([dbPromise, timeoutPromise]);
        fixRow = rows[0] ?? null;
      } catch (dbErr: any) {
        if (dbErr?.message === "db_timeout") {
          dbTimedOut = true;
        } else {
          console.error("[SelfHeal-Button] DB error:", dbErr);
          await interaction.reply({ content: "❌ Database error. Please try again in a moment.", flags: MessageFlags.Ephemeral }).catch(() => {});
          return;
        }
      }

      if (dbTimedOut) {
        // DB is under load — acknowledge and tell user to retry
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xf39c12)
            .setTitle("⚠️ Database Busy")
            .setDescription("The database is slow right now and couldn't load the fix in time.\n\nPlease **try clicking the button again** in a few seconds — it should work once the DB recovers.")
            .setTimestamp()],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }

      if (!fixRow) {
        // Row not in DB (very old fix) — regenerate from most recent error
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const { rows: errRows } = await pool.query(
            `SELECT error_msg, stack, context, ai_analysis FROM self_heal_errors ORDER BY occurred_at DESC LIMIT 1`,
          );
          if (!errRows[0]) {
            await interaction.editReply("⚠️ No recent errors found to regenerate a fix. Please trigger the error again.");
            return;
          }
          const { error_msg, stack, context: errContext, ai_analysis } = errRows[0];
          const newSuggestion = (await generateWithFallback({
            contents: [{
              role: "user",
              parts: [{ text: `You are an expert TypeScript/discord.js developer. A fix suggestion was lost due to a bot restart.\nRegenerate a detailed code fix suggestion for this error:\n\nError: ${error_msg}\nStack: ${(stack ?? "").slice(0, 800)}\nPrevious analysis: ${ai_analysis ?? "none"}\n\nRespond with ONLY a clear, actionable fix description (no markdown headers, just plain text steps).` }],
            }],
          })) ?? "Could not regenerate suggestion.";
          const targetFile = errContext?.includes("tweet") ? "tweet-monitor.ts"
            : errContext?.includes("heal") ? "self-heal.ts"
            : errContext?.includes("coder") ? "ai-coder.ts"
            : "discord-bot.ts";
          const { rows: newFixRows } = await pool.query(
            `INSERT INTO self_heal_pending_fixes (context, suggestion, target_file) VALUES ($1, $2, $3) RETURNING id`,
            [errContext ?? "regenerated", newSuggestion.slice(0, 3900), targetFile],
          );
          const newFixId = newFixRows[0]?.id;
          const newBtn = new ButtonBuilder()
            .setCustomId(`sh_apply:${newFixId}`)
            .setLabel("🔧 Apply Regenerated Fix")
            .setStyle(ButtonStyle.Primary);
          await interaction.editReply({
            content: `♻️ **Fix regenerated** (previous was lost after restart):\n\n${newSuggestion.slice(0, 1800)}\n\n⬇️ Click the button below to apply:`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(newBtn)],
          });
        } catch (regenErr) {
          console.error("[SelfHeal-Button] Regen error:", regenErr);
          await interaction.editReply("⚠️ Could not regenerate fix. Please re-trigger the error scenario.").catch(() => {});
        }
        return;
      }

      // DB returned the row — show the modal
      try {
        await showFixModal(fixRow);
      } catch (e) {
        console.error("[SelfHeal-Button] Modal error (DB path):", e);
        await interaction.reply({ content: "❌ Could not open fix dialog. Please try again.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }

    // ── Modal Submit: sh_modal — AI Coder applies the patch ────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith("sh_modal:")) {
      if (!isBotOwner(interaction.user.id)) {
        await interaction.reply({ content: "🔒 **Access denied.** Only the bot owner can use this.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetFileRaw = interaction.fields.getTextInputValue("target").trim();
      const description   = interaction.fields.getTextInputValue("description").trim();
      const fixId         = interaction.customId.split(":")[1];

      // Normalise: strip leading slash, workspace root, or full paths
      const targetFileRel = targetFileRaw
        .replace(/^\/home\/runner\/workspace\/?/, "")
        .replace(/^artifacts\//, "artifacts/")
        .replace(/\\/g, "/")
        .trim();

      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle("🤖 AI Coder — Generating Patch...")
          .setDescription(
            `**Target:** \`${targetFileRel}\`\n\n` +
            `**Suggestion:**\n${description.slice(0, 800)}\n\n` +
            `⏳ Asking Gemini to generate a surgical code patch. This takes 10-30 seconds...`
          )
          .setTimestamp()],
      });

      try {
        const result = await applyManualFix(targetFileRel, description, `sh_modal:${fixId}`);

        const statusColors: Record<string, number> = {
          applied:       0x00b894,
          failed_ts:     0xe17055,
          failed_build:  0xe17055,
          failed_patch:  0xfdcb6e,
          no_fix:        0xfdcb6e,
          no_file:       0xe74c3c,
        };

        const embed = new EmbedBuilder()
          .setColor(statusColors[result.status] ?? 0x636e72)
          .setTitle(result.applied ? "✅ AI Coder — Fix Applied!" : "❌ AI Coder — Fix Failed")
          .addFields(
            { name: "📁 Target File",  value: `\`${targetFileRel}\``,  inline: false },
            { name: "📋 Result",       value: result.description.slice(0, 1024), inline: false },
            { name: "📊 Status",       value: `\`${result.status}\``,  inline: true  },
          )
          .setTimestamp();

        if (result.applied) {
          embed.setDescription("✅ The patch was validated (TypeScript + build) and applied.\n🔄 Bot is restarting to activate the fix...\n⚡ Render will auto-sync within 30 minutes.");
        } else {
          embed.setDescription("❌ The patch could not be safely applied. No changes were made to the source. You can try editing the suggestion and clicking Apply Fix again.");
        }

        await interaction.editReply({ embeds: [embed] });
      } catch (err: any) {
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("❌ AI Coder — Unexpected Error")
            .setDescription(`\`\`\`${String(err?.message ?? err).slice(0, 500)}\`\`\``)
            .setTimestamp()],
        });
      }
      return;
    }
  });

  // ── Main slash-command handler ─────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // ── Safety net: guarantee Discord never sees "did not respond" ─────────────
    // If the handler hasn't acknowledged the interaction within 2.4 s, send an
    // ephemeral holding reply.  After this fires, the command handler continues
    // and uses editReply() to update (or its own editReply silently overwrites).
    const safetyTimer = setTimeout(async () => {
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: "⏳ Processing…", flags: MessageFlags.Ephemeral });
          console.warn(`[Slash] Safety-net fired for /${commandName} — interaction was about to expire`);
        } catch { /* already acknowledged by the normal path */ }
      }
    }, 1800); // 1800ms gives 1200ms buffer before Discord's hard 3s deadline

    try {
      // ── Cross-instance dedup: only ONE bot instance handles each interaction ──
      // Prevents DiscordAPIError[40060] when dev + production run simultaneously.
      // IMPORTANT: this must be inside try-catch — if DB is idle (post-sleep), it
      // can throw and leave the interaction unanswered ("did not respond" error).
      let claimed: boolean;
      try {
        claimed = await tryClaimInteraction(interaction.id);
      } catch (dbErr) {
        console.warn("[Slash] tryClaimInteraction DB error — proceeding without dedup:", dbErr);
        claimed = true; // assume we own it; better duplicate than silent failure
      }
      if (!claimed) { clearTimeout(safetyTimer); return; }

      // ── /ping ──────────────────────────────────────────────────────────────
      if (commandName === "ping") {
        const latency = Date.now() - interaction.createdTimestamp;
        await interaction.reply(`🏓 Pong! Latency: **${latency}ms** | WebSocket: **${client.ws.ping}ms**`);
        return;
      }

      // ── /help ──────────────────────────────────────────────────────────────
      if (commandName === "help") {
        const embed = new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle("📋 PIXEL_PR — All Slash Commands")
          .setDescription("Use `/` to browse commands. Here's a full overview by category:")
          .addFields(
            { name: "🤖 AI Chat", value: "`/pixel` `/search` `/imagine` `/aesthetic` `/summary` `/forget` `/chat`", inline: false },
            { name: "🎭 Persona", value: "`/persona show` `/persona presets` `/persona preset` `/persona set` `/persona clear`", inline: false },
            { name: "⭐ Reputation", value: "`/giverep` `/rep` `/leaderboard`", inline: false },
            { name: "🎮 Games", value: "`/wyr` `/wordchain` `/stopchain`", inline: false },
            { name: "📅 Events & Reminders", value: "`/event create` `/event list` `/event info` `/event delete` `/event edit`", inline: false },
            { name: "🇯🇵 JP Radar", value: "`/jptime` `/jpairing` `/setjpchannel` `/jpalerts`", inline: false },
            { name: "📺 Tracker", value: "`/track` `/untrack` `/tracklist` `/trackchannel` `/countdown`", inline: false },
            { name: "🔨 Moderation", value: "`/kick` `/ban` `/mute` `/unmute` `/warn` `/warnings` `/clearwarns` `/lock` `/unlock` `/slowmode`", inline: false },
            { name: "📻 Radio", value: "`/radiostatus` `/stations` `/radiostop` `/setradio` `/radioplay` `/radiopause` `/radiostation` `/radiosearch`", inline: false },
            { name: "🖼️ Steganography", value: "`/hide` `/reveal`", inline: false },
            { name: "🧑‍💼 Profiling", value: "`/profile` `/myprofile` `/setprofilechannel`", inline: false },
            { name: "📊 Sentiment", value: "`/briefing` `/setreport`", inline: false },
            { name: "🔒 Privacy", value: "`/privacy` `/accept`", inline: false },
            { name: "📢 Utilities", value: "`/say` `/role` `/daily` `/feature`\n> 🌐 **Translation:** React to any message with a flag emoji (🇸🇦 🇺🇸 🇯🇵…) to auto-translate it!", inline: false },
            { name: "📺 YouTube Monitor", value: "`/addyoutube` `/removeyoutube` `/youtubelist`", inline: false },
            { name: "🐦 Twitter/X Monitor", value: "`/addtwitter` `/removetwitter` `/twitterlist`", inline: false },
            { name: "📰 أخبار عاجلة — News Alerts", value: "`/news-alerts set` — حدد قناة الأخبار العاجلة (عربي + دولي + ياباني)\n`/news-alerts stop` — أوقف الأخبار\n`/news-alerts status` — الحالة والمصادر", inline: false },
            { name: "🎬 أخبار ترفيهية — TV & Anime News", value: "`/tv-news set` — حدد قناة أخبار الأنمي والأفلام والدراما الكورية\n`/tv-news stop` — أوقف الأخبار\n`/tv-news status` — الحالة والمصادر", inline: false },
            { name: "⚙️ Admin — AI & Server", value: "`/clearchat` `/setserverlog` `/removeserverlog` `/setwelcome` `/setwelcomemsg` `/removewelcome` `/testwelcome`", inline: false },
            { name: "🔧 Utility", value: "`/ping` `/avatar` `/serverinfo` `/userinfo` `/help`", inline: false },
          )
          .setFooter({ text: "Use !help for prefix commands • PIXEL_PR#3192" });
        await interaction.reply({ embeds: [embed], ephemeral: false });
        return;
      }

      // ── /avatar ────────────────────────────────────────────────────────────
      if (commandName === "avatar") {
        const target = interaction.options.getUser("user") ?? interaction.user;
        const url    = target.displayAvatarURL({ size: 512 });
        const embed  = new EmbedBuilder()
          .setTitle(`${target.username}'s Avatar`)
          .setImage(url)
          .setColor(0x9b59b6);
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /serverinfo ────────────────────────────────────────────────────────
      if (commandName === "serverinfo") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const g = interaction.guild;
        const embed = new EmbedBuilder()
          .setTitle(g.name)
          .setThumbnail(g.iconURL())
          .addFields(
            { name: "Members",  value: String(g.memberCount),              inline: true },
            { name: "Owner",    value: `<@${g.ownerId}>`,                  inline: true },
            { name: "Created",  value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true },
            { name: "Channels", value: String(g.channels.cache.size),      inline: true },
            { name: "Roles",    value: String(g.roles.cache.size),          inline: true },
          )
          .setColor(0x2ecc71);
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /userinfo ──────────────────────────────────────────────────────────
      if (commandName === "userinfo") {
        const target = interaction.options.getUser("user") ?? interaction.user;
        const member = interaction.guild?.members.cache.get(target.id);
        const warns  = interaction.guildId ? getWarnings(interaction.guildId, target.id) : [];
        const embed  = new EmbedBuilder()
          .setTitle(target.tag)
          .setThumbnail(target.displayAvatarURL())
          .addFields(
            { name: "ID",       value: target.id,                                              inline: true },
            { name: "Joined",   value: member ? `<t:${Math.floor(member.joinedTimestamp!/1000)}:D>` : "N/A", inline: true },
            { name: "Warnings", value: warns.length === 0 ? "None" : warns.map((w,i)=>`${i+1}. ${w}`).join("\n"), inline: false },
          )
          .setColor(0x3498db);
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /pixel ─────────────────────────────────────────────────────────────
      if (commandName === "pixel") {
        await interaction.deferReply();
        const question = interaction.options.getString("question", true);
        const guildId  = interaction.guildId ?? "global";
        const answer   = await askPixel(interaction.user.id, guildId, question);
        await replyAI(interaction, answer);
        return;
      }

      // ── /search ────────────────────────────────────────────────────────────
      if (commandName === "search") {
        await interaction.deferReply();
        const topic  = interaction.options.getString("topic", true);
        const guildId = interaction.guildId ?? "global";
        const prompt = `Give a concise, well-structured summary about: ${topic}. Use bullet points where appropriate. Keep it under 800 words.`;
        const answer  = await askPixel(interaction.user.id, guildId, prompt);
        await replyAI(interaction, answer);
        return;
      }

      // ── /imagine ───────────────────────────────────────────────────────────
      if (commandName === "imagine") {
        await interaction.deferReply();
        const desc = interaction.options.getString("description", true);
        try {
          const { b64_json, mimeType } = await generateImage(desc);
          const ext      = mimeType.includes("jpeg") ? "jpg" : "png";
          const fileName = `pixel_imagine.${ext}`;
          const buffer   = Buffer.from(b64_json, "base64");
          const embed    = new EmbedBuilder()
            .setTitle("🎨 AI Generated Image")
            .setDescription(`**Prompt:** ${desc}`)
            .setImage(`attachment://${fileName}`)
            .setColor(0x5865f2)
            .setFooter({ text: `Requested by ${interaction.user.tag} • Gemini AI` });
          await interaction.editReply({ embeds: [embed], files: [{ attachment: buffer, name: fileName }] });
        } catch (err: any) {
          await interaction.editReply(`❌ Image generation failed: ${err.message}`);
        }
        return;
      }

      // ── /aesthetic ─────────────────────────────────────────────────────────
      if (commandName === "aesthetic") {
        await interaction.deferReply();
        const text    = interaction.options.getString("text", true);
        const guildId = interaction.guildId ?? "global";
        const prompt  = `For the text: "${text}"\n1. Translate to Japanese (romaji + kanji)\n2. Show in 3 different Unicode decorative font styles\n3. Generate 5 relevant hashtags\n\nFormat neatly with emoji.`;
        const answer  = await askPixel(interaction.user.id, guildId, prompt);
        await replyAI(interaction, answer);
        return;
      }

      // ── /summary ───────────────────────────────────────────────────────────
      if (commandName === "summary") {
        await interaction.deferReply();
        try {
          const ch  = interaction.channel as TextChannel;
          const msgs = (await ch.messages.fetch({ limit: 50 })).filter(m => !m.author.bot);
          if (msgs.size < 3) { await interaction.editReply("Not enough messages to summarize."); return; }
          const text = msgs.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n");
          const guildId = interaction.guildId ?? "global";
          const answer  = await askPixel(interaction.user.id, guildId,
            `Summarize this Discord conversation in a few bullet points:\n${text.slice(0, 3000)}`);
          await replyAI(interaction, answer);
        } catch { await interaction.editReply("❌ Could not fetch messages."); }
        return;
      }

      // ── /forget ────────────────────────────────────────────────────────────
      if (commandName === "forget") {
        const guildId = interaction.guildId ?? "global";
        clearHistory(interaction.user.id, guildId);
        await clearMemory(interaction.user.id, guildId);
        await interaction.reply("✅ Cleared your conversation history and long-term memory.");
        return;
      }

      // ── /persona ───────────────────────────────────────────────────────────
      if (commandName === "persona") {
        const sub     = interaction.options.getSubcommand();
        const scopeId = interaction.guildId ?? `dm:${interaction.user.id}`;
        const isAdmin = !interaction.guild ||
          (interaction.member as GuildMember)?.permissions.has(PermissionFlagsBits.Administrator);

        if (sub === "show") {
          const name = getPersonaName(scopeId);
          if (!name) {
            await interaction.reply("🎭 No persona active. PIXEL is running as herself.\nUse `/persona presets` to see built-in characters.");
          } else {
            const embed = new EmbedBuilder()
              .setColor(0x9b59b6)
              .setTitle(`🎭 Active Persona — ${name}`)
              .setFooter({ text: "Use /persona clear to reset to PIXEL" });
            await interaction.reply({ embeds: [embed] });
          }
          return;
        }

        if (sub === "presets") {
          const lines = Object.entries(PERSONA_PRESETS).map(
            ([key, p]) => `${p.emoji} **${p.name}** *(${p.source})*\n> \`/persona preset\` → choose \`${key}\``,
          );
          const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle("🎭 Built-in Character Presets")
            .setDescription(lines.join("\n\n"))
            .setFooter({ text: "Use /persona set for custom characters" });
          await interaction.reply({ embeds: [embed] });
          return;
        }

        if (sub === "preset") {
          if (!isAdmin) { await interaction.reply({ content: "⛔ Admins only.", flags: MessageFlags.Ephemeral }); return; }
          const key    = interaction.options.getString("key", true);
          const preset = PERSONA_PRESETS[key];
          if (!preset) { await interaction.reply({ content: "❌ Unknown preset.", flags: MessageFlags.Ephemeral }); return; }
          await interaction.deferReply();
          await setPersona(scopeId, preset.name, preset.description, interaction.user.id);
          const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`${preset.emoji} Persona Activated — ${preset.name}`)
            .setDescription(`PIXEL will now speak as **${preset.name}**.\nUse \`/persona clear\` to reset.`)
            .setFooter({ text: preset.source });
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        if (sub === "set") {
          if (!isAdmin) { await interaction.reply({ content: "⛔ Admins only.", flags: MessageFlags.Ephemeral }); return; }
          const name = interaction.options.getString("name", true);
          const desc = interaction.options.getString("description", true);
          if (desc.length < 20) { await interaction.reply({ content: "⚠️ Description must be at least 20 characters.", flags: MessageFlags.Ephemeral }); return; }
          await interaction.deferReply();
          await setPersona(scopeId, name, desc, interaction.user.id);
          const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`🎭 Persona Activated — ${name}`)
            .setDescription(desc.slice(0, 4000))
            .setFooter({ text: "Use /persona clear to reset to PIXEL" });
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        if (sub === "clear") {
          if (!isAdmin) { await interaction.reply({ content: "⛔ Admins only.", flags: MessageFlags.Ephemeral }); return; }
          await interaction.deferReply();
          await clearPersona(scopeId);
          await interaction.editReply("✅ Persona cleared. PIXEL is back to her normal self.");
          return;
        }
      }

      // ── /giverep ───────────────────────────────────────────────────────────
      if (commandName === "giverep") {
        const target  = interaction.options.getUser("user", true);
        const guildId = interaction.guildId ?? "global";
        if (target.id === interaction.user.id) { await interaction.reply({ content: "😅 You can't give rep to yourself!", flags: MessageFlags.Ephemeral }); return; }
        if (target.bot) { await interaction.reply({ content: "❌ Can't give rep to a bot!", flags: MessageFlags.Ephemeral }); return; }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const giverRecord = await db.query.reputationTable.findFirst({
          where: and(eq(reputationTable.userId, interaction.user.id), eq(reputationTable.guildId, guildId)),
        });
        if (giverRecord?.lastGivenAt) {
          const elapsed = Date.now() - giverRecord.lastGivenAt.getTime();
          if (elapsed < REP_COOLDOWN_MS) {
            const h = Math.ceil((REP_COOLDOWN_MS - elapsed) / 3_600_000);
            await interaction.editReply(`⏳ You can give rep again in **${h} hour(s)**.`);
            return;
          }
        }
        const existing = await db.query.reputationTable.findFirst({
          where: and(eq(reputationTable.userId, target.id), eq(reputationTable.guildId, guildId)),
        });
        if (existing) {
          await db.update(reputationTable).set({ points: existing.points + 1 })
            .where(and(eq(reputationTable.userId, target.id), eq(reputationTable.guildId, guildId)));
        } else {
          await db.insert(reputationTable).values({ userId: target.id, guildId, points: 1 });
        }
        if (giverRecord) {
          await db.update(reputationTable).set({ lastGivenAt: new Date() })
            .where(and(eq(reputationTable.userId, interaction.user.id), eq(reputationTable.guildId, guildId)));
        } else {
          await db.insert(reputationTable).values({ userId: interaction.user.id, guildId, points: 0, lastGivenAt: new Date() });
        }
        const newPts = (existing?.points ?? 0) + 1;
        await interaction.editReply(`⭐ You gave reputation to **${target.username}**! They now have **${newPts} points**.`);
        return;
      }

      // ── /rep ───────────────────────────────────────────────────────────────
      if (commandName === "rep") {
        const target  = interaction.options.getUser("user") ?? interaction.user;
        const guildId = interaction.guildId ?? "global";
        await interaction.deferReply();
        const record  = await db.query.reputationTable.findFirst({
          where: and(eq(reputationTable.userId, target.id), eq(reputationTable.guildId, guildId)),
        });
        await interaction.editReply(`⭐ **${target.username}** has **${record?.points ?? 0} reputation points**.`);
        return;
      }

      // ── /leaderboard ───────────────────────────────────────────────────────
      if (commandName === "leaderboard") {
        const guildId = interaction.guildId ?? "global";
        await interaction.deferReply();
        const top = await db.select().from(reputationTable)
          .where(eq(reputationTable.guildId, guildId))
          .orderBy(desc(reputationTable.points))
          .limit(10);
        if (top.length === 0) { await interaction.editReply("No reputation data yet. Start giving `/giverep` to members!"); return; }
        const lines = await Promise.all(top.map(async (row, i) => {
          const user  = await client.users.fetch(row.userId).catch(() => null);
          const name  = user?.username ?? `User ${row.userId}`;
          const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
          return `${medal} **${name}** — ${row.points} pts`;
        }));
        const embed = new EmbedBuilder()
          .setTitle("🏆 Reputation Leaderboard")
          .setDescription(lines.join("\n"))
          .setColor(0xffd700);
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /wyr ───────────────────────────────────────────────────────────────
      if (commandName === "wyr") {
        await interaction.deferReply();
        const wyrText = await generateWithFallback({
          contents: [{ role: "user", parts: [{ text: "Give me a fun 'Would You Rather' question with two clear options. Format it exactly like this:\n**Would You Rather...**\n🅰️ Option A\n🅱️ Option B\n\nKeep it light-hearted and suitable for all ages." }] }],
        });
        await interaction.editReply(wyrText ?? "🤔 Couldn't think of one!");
        return;
      }

      // ── /wordchain ────────────────────────────────────────────────────────
      if (commandName === "wordchain") {
        const result = startWordChain(interaction.channelId, client.user!.id);
        if (!result.started) {
          await interaction.reply({
            content: `🔤 A word chain game is already running!\nCurrent word: **${result.currentWord.toUpperCase()}** — give a word starting with **${result.currentWord.slice(-1).toUpperCase()}**.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply(
            `🔤 **Word Chain Game Started!**\n` +
            `Rules: Reply with a word that starts with the **last letter** of my word. No repeating words!\n` +
            `Use \`/stopchain\` to end the game.\n\n` +
            `My word: **${result.currentWord.toUpperCase()}** — your turn! Give a word starting with **${result.currentWord.slice(-1).toUpperCase()}**.`
          );
        }
        return;
      }

      // ── /stopchain ────────────────────────────────────────────────────────
      if (commandName === "stopchain") {
        const stopped = stopWordChain(interaction.channelId);
        await interaction.reply(
          stopped
            ? "🛑 Word chain game stopped. GG! Use `/wordchain` to start a new one."
            : "ℹ️ No word chain game is currently running in this channel."
        );
        return;
      }

      // ── /jptime ────────────────────────────────────────────────────────────
      if (commandName === "jptime") {
        await interaction.deferReply();
        const guildId = interaction.guildId ?? "global";
        const answer  = await askPixel(interaction.user.id, guildId,
          "What time is it right now in Tokyo, Japan (JST)? Give the current time and a fun vibe/mood label (like 'midnight anime hour', 'morning rush', etc.). Keep it short and fun.");
        await replyAI(interaction, answer);
        return;
      }

      // ── /jpairing ──────────────────────────────────────────────────────────
      if (commandName === "jpairing") {
        await interaction.deferReply();
        const guildId = interaction.guildId ?? "global";
        const answer  = await askPixel(interaction.user.id, guildId,
          "What popular anime is airing right now in Japan? List 3-5 currently airing anime with a brief description of each. Make it fun and include the day/time they air in JST if you know.");
        await replyAI(interaction, answer);
        return;
      }

      // ── /kick ──────────────────────────────────────────────────────────────
      if (commandName === "kick") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getMember("user") as GuildMember | null;
        if (!target) { await interaction.reply({ content: "❌ Member not found.", flags: MessageFlags.Ephemeral }); return; }
        const reason = interaction.options.getString("reason") ?? "No reason provided";
        await interaction.deferReply();
        try {
          await target.kick(reason);
          await interaction.editReply(`✅ **${target.user.tag}** has been kicked. Reason: ${reason}`);
        } catch { await interaction.editReply("❌ Could not kick that member."); }
        return;
      }

      // ── /ban ───────────────────────────────────────────────────────────────
      if (commandName === "ban") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getMember("user") as GuildMember | null;
        if (!target) { await interaction.reply({ content: "❌ Member not found.", flags: MessageFlags.Ephemeral }); return; }
        const reason = interaction.options.getString("reason") ?? "No reason provided";
        await interaction.deferReply();
        try {
          await target.ban({ reason });
          await interaction.editReply(`🔨 **${target.user.tag}** has been banned. Reason: ${reason}`);
        } catch { await interaction.editReply("❌ Could not ban that member."); }
        return;
      }

      // ── /mute ──────────────────────────────────────────────────────────────
      if (commandName === "mute") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target  = interaction.options.getMember("user") as GuildMember | null;
        if (!target) { await interaction.reply({ content: "❌ Member not found.", flags: MessageFlags.Ephemeral }); return; }
        const minutes = interaction.options.getInteger("minutes") ?? 10;
        const reason  = interaction.options.getString("reason") ?? "No reason provided";
        await interaction.deferReply();
        try {
          await target.timeout(minutes * 60 * 1000, reason);
          await interaction.editReply(`🔇 **${target.user.tag}** muted for **${minutes} min**. Reason: ${reason}`);
        } catch { await interaction.editReply("❌ Could not mute that member."); }
        return;
      }

      // ── /unmute ────────────────────────────────────────────────────────────
      if (commandName === "unmute") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getMember("user") as GuildMember | null;
        if (!target) { await interaction.reply({ content: "❌ Member not found.", flags: MessageFlags.Ephemeral }); return; }
        await interaction.deferReply();
        try {
          await target.timeout(null);
          await interaction.editReply(`🔊 **${target.user.tag}** has been unmuted.`);
        } catch { await interaction.editReply("❌ Could not unmute that member."); }
        return;
      }

      // ── /warn ──────────────────────────────────────────────────────────────
      if (commandName === "warn") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getMember("user") as GuildMember | null;
        if (!target) { await interaction.reply({ content: "❌ Member not found.", flags: MessageFlags.Ephemeral }); return; }
        const reason = interaction.options.getString("reason") ?? "No reason provided";
        await interaction.deferReply();
        await addWarningAndCheck(
          interaction.guildId!,
          target.id,
          reason,
          target,
          interaction.channel as TextChannel,
        );
        const count = getWarnings(interaction.guildId!, target.id).length;
        await interaction.editReply(`⚠️ **${target.user.tag}** warned. Total warnings: **${count}**. Reason: ${reason}`);
        return;
      }

      // ── /warnings ──────────────────────────────────────────────────────────
      if (commandName === "warnings") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getUser("user") ?? interaction.user;
        const warns  = getWarnings(interaction.guildId!, target.id);
        if (warns.length === 0) {
          await interaction.reply(`✅ **${target.username}** has no warnings.`);
        } else {
          await interaction.reply(`⚠️ **${target.username}** has **${warns.length}** warning(s):\n${warns.map((w,i)=>`${i+1}. ${w}`).join("\n")}`);
        }
        return;
      }

      // ── /clearwarns ────────────────────────────────────────────────────────
      if (commandName === "clearwarns") {
        if (!interaction.guild) { await interaction.reply({ content: "Server only!", flags: MessageFlags.Ephemeral }); return; }
        const target = interaction.options.getUser("user", true);
        clearWarnings(interaction.guildId!, target.id);
        await interaction.reply(`✅ Cleared all warnings for **${target.username}**.`);
        return;
      }

      // ── /lock ──────────────────────────────────────────────────────────────
      if (commandName === "lock") {
        if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "Text channel only!", flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply();
        try {
          await (interaction.channel as TextChannel).permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            { SendMessages: false },
          );
          await interaction.editReply("🔒 Channel locked.");
        } catch { await interaction.editReply("❌ Could not lock channel."); }
        return;
      }

      // ── /unlock ────────────────────────────────────────────────────────────
      if (commandName === "unlock") {
        if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "Text channel only!", flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply();
        try {
          await (interaction.channel as TextChannel).permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            { SendMessages: null },
          );
          await interaction.editReply("🔓 Channel unlocked.");
        } catch { await interaction.editReply("❌ Could not unlock channel."); }
        return;
      }

      // ── /slowmode ──────────────────────────────────────────────────────────
      if (commandName === "slowmode") {
        if (!interaction.guild || interaction.channel?.type !== ChannelType.GuildText) {
          await interaction.reply({ content: "Text channel only!", flags: MessageFlags.Ephemeral }); return;
        }
        const secs = interaction.options.getInteger("seconds") ?? 0;
        await interaction.deferReply();
        try {
          await (interaction.channel as TextChannel).setRateLimitPerUser(secs);
          await interaction.editReply(secs === 0 ? "✅ Slowmode disabled." : `✅ Slowmode set to **${secs}s**.`);
        } catch { await interaction.editReply("❌ Could not set slowmode."); }
        return;
      }

      // ── /radiostatus ───────────────────────────────────────────────────────
      if (commandName === "radiostatus") {
        const gid = interaction.guildId!;
        const state = radioStates.get(gid);
        if (!state) {
          await interaction.reply({ content: "📻 Radio is not active in this server.", flags: MessageFlags.Ephemeral }); return;
        }
        const embed = new EmbedBuilder()
          .setTitle("📻 Radio Status")
          .setColor(0x9b59b6)
          .addFields(
            { name: "Station", value: state.stationName, inline: true },
            { name: "Status", value: state.stopped ? "⏹ Stopped" : "▶ Playing", inline: true },
            { name: "Voice Channel", value: `<#${state.voiceChannelId}>`, inline: true },
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /stations ──────────────────────────────────────────────────────────
      if (commandName === "stations") {
        const categoryEmoji: Record<string, string> = {
          music:  "🎵",
          news:   "🌐",
          arabic: "🌍",
          japan:  "🇯🇵",
        };
        const categoryLabel: Record<string, string> = {
          music:  "Music",
          news:   "International News",
          arabic: "الإذاعات الإخبارية العربية",
          japan:  "Japan / Anime",
        };
        const groups: Record<string, string[]> = {};
        for (const [key, s] of Object.entries(BUILTIN_STATIONS)) {
          if (!groups[s.category]) groups[s.category] = [];
          groups[s.category].push(`**\`${key}\`** — ${s.name}\n<${s.url}>`);
        }
        const embed = new EmbedBuilder()
          .setTitle("📻 Available Stations")
          .setColor(0x9b59b6)
          .setFooter({ text: "Use /setradio station:<key> or /radiostation <key> to switch" });
        for (const [cat, lines] of Object.entries(groups)) {
          const emoji = categoryEmoji[cat] ?? "📡";
          const label = categoryLabel[cat] ?? cat;
          embed.addFields({ name: `${emoji} ${label}`, value: lines.join("\n"), inline: false });
        }
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /radiostop ─────────────────────────────────────────────────────────
      if (commandName === "radiostop") {
        const gid = interaction.guildId!;
        await interaction.deferReply();
        const state = radioStates.get(gid);
        if (!state) { await interaction.editReply("📻 Radio is not active."); return; }
        await stopRadio(gid);
        await interaction.editReply("⏹ Radio stopped.");
        return;
      }

      // ── /setradio ──────────────────────────────────────────────────────────
      if (commandName === "setradio") {
        const gid     = interaction.guildId!;
        const voiceCh = interaction.options.getChannel("voice") as VoiceChannel;
        const textCh  = (interaction.options.getChannel("text") ?? interaction.channel) as TextChannel;
        const stKey   = interaction.options.getString("station") ?? "lofi";
        const resolved = resolveStation(stKey);
        if (!resolved) {
          await interaction.reply({ content: `❌ Unknown station \`${stKey}\`.\nUse \`/stations\` to see all available keys.`, flags: MessageFlags.Ephemeral }); return;
        }
        const { key: resolvedKey, station: stInfo, suggestion } = resolved;
        const newState: RadioState = {
          guildId: gid,
          voiceChannelId: voiceCh.id,
          textChannelId:  textCh.id,
          streamUrl:      stInfo.url,
          stationName:    stInfo.name,
          stationKey:     resolvedKey,
          stopped:        true,
        };
        radioStates.set(gid, newState);
        await interaction.deferReply();
        await saveRadioConfig(newState);
        const suggestionNote = suggestion ? `\n💡 Matched \`${resolvedKey}\` (you typed \`${stKey}\`)` : "";
        await interaction.editReply(`✅ Radio configured!\n🔊 Voice: **${voiceCh.name}** | 📢 Text: **${textCh.name}** | 🎵 Station: **${stInfo.name}**${suggestionNote}\nUse \`/radioplay\` to start streaming.`);
        return;
      }

      // ── /radioplay ─────────────────────────────────────────────────────────
      if (commandName === "radioplay") {
        const gid = interaction.guildId!;
        await interaction.deferReply();
        const state = radioStates.get(gid);
        if (!state) { await interaction.editReply("❌ No radio configured. Use `/setradio` first."); return; }
        if (!state.stopped) { await interaction.editReply("📻 Radio is already playing!"); return; }
        resetStreamFailCount(gid);
        state.stopped = false;
        await startRadio(client, gid);
        await interaction.editReply(`▶ Radio started — **${state.stationName}**.`);
        return;
      }

      // ── /radiopause ────────────────────────────────────────────────────────
      if (commandName === "radiopause") {
        const gid   = interaction.guildId!;
        const state = radioStates.get(gid);
        if (!state || state.stopped) { await interaction.reply({ content: "📻 Radio is not playing.", flags: MessageFlags.Ephemeral }); return; }
        stopRadio(gid);
        await interaction.reply("⏸ Radio paused. Use `/radioplay` to resume.");
        return;
      }

      // ── /radiostation ──────────────────────────────────────────────────────
      if (commandName === "radiostation") {
        const gid  = interaction.guildId!;
        const key  = interaction.options.getString("key", true);
        const resolved2 = resolveStation(key);
        if (!resolved2) { await interaction.reply({ content: `❌ Unknown station \`${key}\`.\nUse \`/stations\` to see all available keys.`, flags: MessageFlags.Ephemeral }); return; }
        const { key: resolvedKey2, station: info, suggestion: suggestion2 } = resolved2;
        const state = radioStates.get(gid);
        if (!state) { await interaction.reply({ content: "❌ No radio configured. Use `/setradio` first.", flags: MessageFlags.Ephemeral }); return; }
        await interaction.deferReply();
        // Stop current station cleanly before switching — prevents concurrent startRadio race
        await stopRadio(gid);
        resetStreamFailCount(gid);
        state.stationKey  = resolvedKey2;
        state.stationName = info.name;
        state.streamUrl   = info.url;
        state.stopped     = false;
        await saveRadioConfig(state);
        await startRadio(client, gid);
        const note2 = suggestion2 ? ` (matched \`${resolvedKey2}\` from \`${key}\`)` : "";
        await interaction.editReply(`🎵 Switched to **${info.name}**${note2}.`);
        return;
      }

      // ── /streamurl ─────────────────────────────────────────────────────────
      if (commandName === "streamurl") {
        const gid       = interaction.guildId!;
        const streamUrl = interaction.options.getString("url", true).trim();
        const customName = interaction.options.getString("name") ?? null;

        // Basic URL validation
        if (!streamUrl.startsWith("http://") && !streamUrl.startsWith("https://")) {
          await interaction.reply({ content: "❌ URL must start with `http://` or `https://`.", flags: MessageFlags.Ephemeral }); return;
        }

        const state = radioStates.get(gid);
        if (!state) {
          await interaction.reply({ content: "❌ No radio configured yet. Use `/setradio` first to set the voice & text channels.", flags: MessageFlags.Ephemeral }); return;
        }

        const displayName = customName ?? new URL(streamUrl).hostname;
        state.streamUrl   = streamUrl;
        state.stationName = displayName;
        state.stationKey  = "custom";
        state.stopped     = false;

        await interaction.deferReply();
        await saveRadioConfig(state);
        await startRadio(client, gid);
        await interaction.editReply(`🎵 Now streaming: **${displayName}**\n🔗 <${streamUrl}>`);
        return;
      }

      // ── /radiosearch ───────────────────────────────────────────────────────
      if (commandName === "radiosearch") {
        const gid   = interaction.guildId!;
        const query = interaction.options.getString("query", true);
        const state = radioStates.get(gid);
        if (!state) { await interaction.reply({ content: "❌ No radio configured. Use `/setradio` first.", flags: MessageFlags.Ephemeral }); return; }
        await interaction.deferReply();
        const results: RBStation[] = await searchRadioBrowser(query, 1);
        if (!results.length) { await interaction.editReply(`❌ No stations found for "${query}".`); return; }
        const rb = results[0];
        state.streamUrl   = rb.url_resolved;
        state.stationKey  = undefined;
        state.stationName = rb.name;
        await startRadio(client, gid);
        await interaction.editReply(`🎵 Now playing **${rb.name}** (${rb.country || "??"}).`);
        return;
      }

      // ── /voicechat ─────────────────────────────────────────────────────────
      if (commandName === "voicechat") {
        const sub  = interaction.options.getSubcommand();
        const gid  = interaction.guildId!;
        const guild = interaction.guild!;

        if (sub === "on") {
          const member = interaction.member as GuildMember | null;
          const vcId   = member?.voice.channelId ?? null;
          if (!vcId) {
            await interaction.reply({ content: "❌ You need to be in a **voice channel** first, then run `/voicechat on`.", flags: MessageFlags.Ephemeral });
            return;
          }
          const vc = guild.channels.cache.get(vcId);
          if (!vc) {
            await interaction.reply({ content: "❌ Could not find your voice channel.", flags: MessageFlags.Ephemeral });
            return;
          }
          // Use the saved text channel if configured, otherwise fall back to the current channel
          const savedChId  = await getVoiceAIChannel(gid);
          const textChId   = savedChId ?? interaction.channelId;
          activateVoiceAI(client, guild, vcId, textChId);
          const savedNote = savedChId
            ? `\nTranscripts → <#${savedChId}> *(set via \`/setvoicechannel\`)*`
            : `\nTranscripts → <#${interaction.channelId}> *(this channel — use \`/setvoicechannel set\` to change)*`;
          await interaction.reply({
            content:
              `✅ **Voice AI ON** in **${vc.name}** 🎤\n` +
              `Speak — I'll transcribe and reply${savedNote}\n` +
              `Radio keeps playing while I listen.\n` +
              `Use \`/voicechat off\` to stop.`,
          });
          return;
        }

        if (sub === "off") {
          const wasActive = deactivateVoiceAI(gid);
          if (!wasActive) {
            await interaction.reply({ content: "❌ Voice AI is not active.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: "⏹️ **Voice AI OFF**." });
          }
          return;
        }

        if (sub === "status") {
          const state = voiceAIStates.get(gid);
          if (!state?.enabled) {
            await interaction.reply({ content: "Voice AI is **off**. Join a voice channel and use `/voicechat on` to activate.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({
              content:
                `🎤 Voice AI is **ON**\n` +
                `Voice channel: <#${state.voiceChannelId}>\n` +
                `Text channel: <#${state.textChannelId}>\n` +
                `Use \`/voicechat off\` to stop.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
      }

      // ── /setvoicechannel ───────────────────────────────────────────────────
      if (commandName === "setvoicechannel") {
        const sub = interaction.options.getSubcommand();
        const gid = interaction.guildId!;

        if (sub === "set") {
          const ch = interaction.options.getChannel("channel", true) as TextChannel;
          await setVoiceAIChannel(gid, ch.id);
          await interaction.reply({
            content:
              `✅ **Voice AI text channel set** → <#${ch.id}>\n` +
              `All transcripts and AI replies will now go there.\n` +
              `Use \`/voicechat on\` in any channel — output will always land in <#${ch.id}>.\n` +
              `Use \`/setvoicechannel clear\` to remove this setting.`,
          });
          return;
        }

        if (sub === "clear") {
          const removed = await removeVoiceAIChannel(gid);
          await interaction.reply({
            content: removed
              ? "🗑️ **Voice AI channel cleared** — transcripts will now go to whichever channel `/voicechat on` is run in."
              : "❌ No Voice AI channel was saved.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "status") {
          const chId = await getVoiceAIChannel(gid);
          const activeState = voiceAIStates.get(gid);
          if (!chId) {
            await interaction.reply({
              content:
                "No saved Voice AI channel. Transcripts go to whichever channel `/voicechat on` is used in.\n" +
                "Use `/setvoicechannel set #channel` to pin it.",
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content:
                `🎙️ **Voice AI text channel:** <#${chId}>\n` +
                (activeState?.enabled
                  ? `🟢 Voice AI is **active** in <#${activeState.voiceChannelId}>`
                  : "⚫ Voice AI is currently **off** (`/voicechat on` to start)"),
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
      }

      // ── /twitterpoll ───────────────────────────────────────────────────────
      if (commandName === "twitterpoll") {
        const username = cleanUsername(interaction.options.getString("username", true));
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const proxyUrl    = process.env.TWITTER_PROXY_URL;
        const proxySecret = process.env.TWITTER_PROXY_SECRET;

        // ── Step 1: Try fetchLatestTweets (real path, no extra Worker call) ──
        let fetchResult: { tweets: any[]; source: string } | null = null;
        let fetchErr = "";
        try {
          fetchResult = await fetchLatestTweets(username);
        } catch (err: any) {
          fetchErr = String(err?.message ?? err);
        }

        // ── Step 2: On success → show result immediately ──
        if (fetchResult) {
          const { tweets, source } = fetchResult;
          if (!tweets.length) {
            await interaction.editReply(
              `✅ **@${username}** — fetched via \`${source}\`\n` +
              `📭 No new tweets found (account may have no recent tweets, or all are already seen).`,
            );
            return;
          }
          const latest = tweets[0];
          await interaction.editReply(
            `✅ **@${username}** — fetched via \`${source}\`\n` +
            `📨 **${tweets.length}** tweet(s) found. Latest:\n> ${latest?.text.slice(0, 200)}\n` +
            `🔗 ${latest?.url}`,
          );
          const textCh = interaction.channel as TextChannel | null;
          if (textCh) {
            for (const t of tweets.slice(0, 3)) {
              await textCh.send({
                embeds: [buildTweetEmbed(t, username)],
                components: [buildTweetButton(t.url)],
              }).catch(() => {});
            }
          }
          return;
        }

        // ── Step 3: Fetch failed — run proxy test for diagnostics ──
        let proxyTest = "⏭️ skipped (TWITTER_PROXY_URL not set)";
        if (proxyUrl && proxySecret) {
          try {
            const testUrl = new URL(proxyUrl);
            testUrl.searchParams.set("username", username);
            const r = await fetch(testUrl.toString(), {
              headers: { Authorization: `Bearer ${proxySecret}` },
              signal: AbortSignal.timeout(15_000),
            });
            const body = await r.text();
            proxyTest = `HTTP ${r.status} → \`${body.slice(0, 150)}\``;
            // Cache the userId returned by the Worker so the next real poll can skip UserByScreenName
            try {
              const parsed = JSON.parse(body) as { userId?: string };
              if (parsed.userId) await cacheTwitterUserId(username, parsed.userId);
            } catch { /* ignore parse errors */ }
          } catch (e: any) {
            proxyTest = `❌ ${e.message}`;
          }
        }

        await interaction.editReply(
          `🔧 **Proxy URL:** ${proxyUrl ? `\`${proxyUrl.slice(0, 55)}\`` : "❌ NOT SET"}\n` +
          `🔑 **Secret:** ${proxySecret ? "✅ set" : "❌ NOT SET"}\n` +
          `📡 **Proxy test:** ${proxyTest}\n` +
          `❌ **@${username}** — fetch failed\n` +
          `\`\`\`${fetchErr.slice(0, 500)}\`\`\``,
        );
        return;
      }

      // ── /twitterreset ──────────────────────────────────────────────────────
      if (commandName === "twitterreset") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gid = interaction.guildId!;
        const count = await resetAllTwitterAccounts(gid);
        if (count === 0) {
          await interaction.editReply("✅ All accounts are already healthy — no reset needed.");
        } else {
          await interaction.editReply(
            `♻️ Reset **${count}** failing account(s) — they will retry on the next poll cycle (within 5 minutes).\n` +
            `Use \`/twitterlist\` to check their status after the next poll.`,
          );
        }
        return;
      }

      // ── /twitteradvance ────────────────────────────────────────────────────
      if (commandName === "twitteradvance") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const gid = interaction.guildId!;
        await interaction.editReply("⏳ Syncing all accounts to their actual latest tweet… (may take 30–60 s)");

        const { updated, skipped, failed } = await advanceAllTwitterAccounts(gid);

        const lines: string[] = [];
        if (updated.length) lines.push(`✅ **Synced (${updated.length}):** ${updated.map(u => `@${u}`).join(", ")}`);
        if (skipped.length) lines.push(`🟡 **No tweets found (${skipped.length}):** ${skipped.map(u => `@${u}`).join(", ")}`);
        if (failed.length)  lines.push(`❌ **Failed (${failed.length}):** ${failed.map(u => `@${u}`).join(", ")}`);
        lines.push(`\nFrom now on only **new** tweets will be posted — no old-tweet flood.`);
        lines.push(`Use \`/twitterlist\` to verify.`);

        await interaction.editReply(lines.join("\n"));
        return;
      }

      // ── /jokeschedule ──────────────────────────────────────────────────────
      if (commandName === "jokeschedule") {
        const sub = interaction.options.getSubcommand();
        const gid = interaction.guildId!;

        if (sub === "set") {
          const ch = interaction.options.getChannel("channel", true) as TextChannel;
          await setJokeChannel(gid, ch.id);
          await interaction.reply({
            content:
              `✅ **Joke Scheduler ON** → <#${ch.id}>\n` +
              `PIXEL will auto-post 5 anime jokes per day at: 00:00, 05:00, 10:00, 15:00, 20:00 UTC.\n` +
              `Use \`/jokeschedule off\` to stop.`,
          });
          return;
        }

        if (sub === "off") {
          const removed = await removeJokeChannel(gid);
          await interaction.reply({
            content: removed
              ? "⏹️ **Joke Scheduler OFF** — no more daily jokes."
              : "❌ Joke Scheduler was not active.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (sub === "status") {
          const chId = await getJokeScheduleChannel(gid);
          if (!chId) {
            await interaction.reply({ content: "Joke Scheduler is **off**. Use `/jokeschedule set #channel` to activate.", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const textCh = (
              client.channels.cache.get(chId) ??
              await client.channels.fetch(chId).catch(() => null)
            ) as TextChannel | null;
            await interaction.editReply(
              `😄 Joke Scheduler is **ON**\n` +
              `Channel: <#${chId}>${textCh ? "" : " *(channel not found — may have been deleted)*"}\n` +
              `Times: 00:00, 05:00, 10:00, 15:00, 20:00 UTC (5×/day)\n` +
              `Use \`/jokeschedule off\` to stop.`,
            );
          }
          return;
        }
      }

      // ── /addtwitter ────────────────────────────────────────────────────────
      if (commandName === "addtwitter") {
        const username = interaction.options.getString("username", true);
        const channel  = interaction.options.getChannel("channel", true) as TextChannel;
        const gid      = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const clean = cleanUsername(username);
        // Correct order: addTwitterAccount(guildId, channelId, username)
        await addTwitterAccount(gid, channel.id, clean);
        await interaction.editReply(`✅ Now monitoring **@${clean}** — tweets will be posted in ${channel}.`);
        return;
      }

      // ── /removetwitter ─────────────────────────────────────────────────────
      if (commandName === "removetwitter") {
        const username = interaction.options.getString("username", true);
        const gid      = interaction.guildId!;
        const clean    = cleanUsername(username);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await removeTwitterAccount(gid, clean);
        await interaction.editReply(`✅ Stopped monitoring **@${clean}**.`);
        return;
      }

      // ── /twitterlist ───────────────────────────────────────────────────────
      if (commandName === "twitterlist") {
        const gid  = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const list = await listTwitterAccounts(gid);
        if (!list.length) {
          await interaction.editReply("📭 No Twitter/X accounts are being monitored.\nUse `/addtwitter` to add one.");
          return;
        }

        const healthy   = list.filter(a => !a.unreachable && a.failCount < FAILURE_THRESHOLD);
        const failing   = list.filter(a => !a.unreachable && a.failCount >= FAILURE_THRESHOLD);
        const dead      = list.filter(a => a.unreachable);
        const unseeded  = healthy.filter(a => !a.lastTweetId);

        const fmtAccount = (a: typeof list[0]) => {
          let icon = "✅";
          if (a.unreachable)                       icon = "🔴";
          else if (a.failCount >= FAILURE_THRESHOLD) icon = "⚠️";
          else if (!a.lastTweetId)                  icon = "🟡";
          return `${icon} **@${a.username}** → <#${a.channelId}>`;
        };

        const embed = new EmbedBuilder()
          .setColor(failing.length || dead.length ? Colors.Orange : Colors.Green)
          .setTitle(`🐦 Monitored X / Twitter (${list.length} accounts)`)
          .setTimestamp();

        if (healthy.length)
          embed.addFields({ name: `✅ Active (${healthy.length})`, value: healthy.map(fmtAccount).join("\n"), inline: false });
        if (failing.length) {
          const failLines = failing.map(a => {
            const err = a.lastError ? `\n  └ \`${a.lastError.slice(0, 80)}\`` : "";
            return `⚠️ **@${a.username}** → <#${a.channelId}> *(${a.failCount} errors)*${err}`;
          }).join("\n");
          embed.addFields({ name: `⚠️ Failing (${failing.length}) — retry with /twitterreset`, value: failLines.slice(0, 1020), inline: false });
        }
        if (dead.length) {
          const deadLines = dead.map(a => {
            const err = a.lastError ? `\n  └ \`${a.lastError.slice(0, 80)}\`` : "";
            return `🔴 **@${a.username}** → <#${a.channelId}>${err}`;
          }).join("\n");
          embed.addFields({ name: `🔴 Unreachable (${dead.length})`, value: deadLines.slice(0, 1020), inline: false });
        }

        const tips: string[] = [];
        if (failing.length) tips.push("• Use `/twitterreset` to retry all failing accounts immediately");
        if (failing.length) tips.push("• Use `/twitterpoll username:X` to see the exact error for any account");
        if (unseeded.length) tips.push("• 🟡 accounts are monitored but no tweet captured yet (normal for new/quiet accounts)");
        if (tips.length) embed.setFooter({ text: tips.join("\n") });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /addyoutube ────────────────────────────────────────────────────────
      if (commandName === "addyoutube") {
        const input    = interaction.options.getString("channel_url", true).trim();
        const discordCh = interaction.options.getChannel("discord_channel", true) as TextChannel;
        const gid      = interaction.guildId!;

        await interaction.deferReply();
        const msg = await interaction.editReply("⏳ Resolving YouTube channel… (may take a few seconds)");

        const resolved = await resolveYTChannelId(input).catch(() => null);
        if (!resolved) {
          await interaction.editReply(
            "❌ Could not find that YouTube channel.\n" +
            "Make sure you're using a valid `@handle`, channel URL, or channel ID.\n" +
            "Examples:\n• `@MrBeast`\n• `https://youtube.com/@MrBeast`\n• `UCX6OQ3DkcsbYNE6H8uQQuVA`"
          );
          return;
        }

        const { channelId: ytId, channelName } = resolved;

        // Grab the latest video ID so we don't re-post old videos on first poll
        let lastVideoId: string | null = null;
        try {
          const { rows: rssRows } = await pool.query(
            `SELECT last_video_id FROM youtube_monitors WHERE guild_id=$1 AND yt_channel_id=$2`,
            [gid, ytId]
          );
          if (!rssRows.length) {
            const videos = await fetchYTVideos(ytId).catch(() => []);
            lastVideoId = videos[0]?.videoId ?? null;
          } else {
            lastVideoId = rssRows[0].last_video_id;
          }
        } catch { lastVideoId = null; }

        await addYouTubeChannel({
          guildId:      gid,
          channelId:    discordCh.id,
          ytChannelId:  ytId,
          ytChannelName: channelName,
          lastVideoId,
        });

        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle("📺 YouTube Monitor Added")
          .setDescription(`Now watching **${channelName}** for new videos!`)
          .addFields(
            { name: "📡 Channel", value: `[${channelName}](https://youtube.com/channel/${ytId})`, inline: true },
            { name: "📢 Posts to", value: `${discordCh}`, inline: true },
            { name: "⏱️ Check interval", value: "Every 10 minutes", inline: true },
          )
          .setFooter({ text: `Channel ID: ${ytId}` });

        await interaction.editReply({ content: "", embeds: [embed] });
        return;
      }

      // ── /removeyoutube ─────────────────────────────────────────────────────
      if (commandName === "removeyoutube") {
        const input = interaction.options.getString("channel_url", true).trim();
        const gid   = interaction.guildId!;

        await interaction.deferReply();

        // Try to resolve it as a channel first
        let ytId: string | null = null;
        let ytName = input;

        if (/^UC[\w-]{20,}$/.test(input)) {
          ytId = input;
        } else if (input.includes("youtube.com/channel/")) {
          ytId = input.match(/channel\/(UC[\w-]{20,})/)?.[1] ?? null;
        } else {
          // Try by name match in DB first (faster)
          const handle = input.replace(/^@/, "").replace(/.*youtube\.com\/@?/, "").trim();
          ytId = await findYTChannelByName(gid, handle);
          if (!ytId) {
            const resolved = await resolveYTChannelId(input).catch(() => null);
            ytId   = resolved?.channelId ?? null;
            ytName = resolved?.channelName ?? input;
          }
        }

        if (!ytId) {
          await interaction.editReply(`❌ Could not identify that YouTube channel. Try using the channel ID directly.`);
          return;
        }

        const removed = await removeYouTubeChannel(gid, ytId);
        if (removed) {
          await interaction.editReply(`✅ Stopped monitoring **${ytName}**.`);
        } else {
          await interaction.editReply(`❌ That channel wasn't being monitored. Use \`/youtubelist\` to see active monitors.`);
        }
        return;
      }

      // ── /youtubelist ───────────────────────────────────────────────────────
      if (commandName === "youtubelist") {
        const gid = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const list = await listYouTubeChannels(gid);
        if (!list.length) {
          await interaction.editReply("📭 No YouTube channels are being monitored.\nUse `/addyoutube` to add one!");
          return;
        }

        const lines = list.map(c => {
          const status = c.unreachable ? "🔴" : c.failCount >= 5 ? "⚠️" : "✅";
          return `${status} **${c.ytChannelName}** → <#${c.channelId}>\n  [youtube.com/channel/${c.ytChannelId}](https://youtube.com/channel/${c.ytChannelId})`;
        }).join("\n\n");

        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle("📺 Monitored YouTube Channels")
          .setDescription(lines)
          .setFooter({ text: `${list.length} channel(s) • ✅ active • ⚠️ failing • 🔴 unreachable` });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /setwelcome ────────────────────────────────────────────────────────
      if (commandName === "setwelcome") {
        const gid = interaction.guildId!;
        const ch  = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel;
        await interaction.deferReply();
        await setWelcomeChannel(gid, ch.id);
        await interaction.editReply(`✅ Welcome channel set to ${ch}.\nUse \`/setwelcomemsg\` to set a custom message.`);
        return;
      }

      // ── /setwelcomemsg ─────────────────────────────────────────────────────
      if (commandName === "setwelcomemsg") {
        const gid = interaction.guildId!;
        const msg = interaction.options.getString("message", true);
        await interaction.deferReply();
        await setWelcomeMsg(gid, msg);
        await interaction.editReply(`✅ Welcome message set:\n> ${msg}`);
        return;
      }

      // ── /removewelcome ─────────────────────────────────────────────────────
      if (commandName === "removewelcome") {
        const gid = interaction.guildId!;
        await interaction.deferReply();
        await clearWelcomeConfig(gid);
        await interaction.editReply("✅ Welcome channel config removed.");
        return;
      }

      // ── /testwelcome ───────────────────────────────────────────────────────
      if (commandName === "testwelcome") {
        const gid = interaction.guildId!;
        // Double-guard: prevent both instances from sending the test embed
        // tryClaimGuildEvent is a fast DB INSERT — completes well within 3s window
        const testKey = `testwelcome:${gid}:${interaction.id}`;
        if (!(await tryClaimGuildEvent(testKey))) return;
        const chId = getWelcomeChannelId(gid);
        if (!chId) { await interaction.reply({ content: "❌ No welcome channel set. Use `/setwelcome` first.", flags: MessageFlags.Ephemeral }); return; }
        // Defer before any slow Discord API / async calls
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const ch = await client.channels.fetch(chId).catch(() => null) as TextChannel | null;
        if (!ch) { await interaction.editReply("❌ Welcome channel not found."); return; }
        const member = interaction.member as GuildMember;
        await sendWelcomeEmbed(ch, member, getWelcomeMessage(gid));
        await interaction.editReply(`✅ Test welcome sent to ${ch}.`);
        return;
      }

      // ── /setjpchannel ──────────────────────────────────────────────────────
      if (commandName === "setjpchannel") {
        const gid = interaction.guildId!;
        const ch  = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel;
        const existing = jpConfigs.get(gid);
        const cfg = { channelId: ch.id, alerts: existing?.alerts ?? true };
        jpConfigs.set(gid, cfg);
        await interaction.deferReply();
        await saveJPConfig(gid, cfg);
        await interaction.editReply(`✅ JP Radar alerts will be sent to ${ch}.`);
        return;
      }

      // ── /jpalerts ─────────────────────────────────────────────────────────
      if (commandName === "jpalerts") {
        const gid   = interaction.guildId!;
        const on    = interaction.options.getString("state", true) === "on";
        const cfg   = jpConfigs.get(gid);
        if (!cfg) { await interaction.reply({ content: "❌ No JP Radar channel set. Use `/setjpchannel` first.", flags: MessageFlags.Ephemeral }); return; }
        cfg.alerts = on;
        jpConfigs.set(gid, cfg);
        await interaction.deferReply();
        await saveJPConfig(gid, cfg);
        await interaction.editReply(`✅ JP Radar alerts ${on ? "**enabled**" : "**disabled**"}.`);
        return;
      }

      // ── /setserverlog ──────────────────────────────────────────────────────
      if (commandName === "setserverlog") {
        const gid = interaction.guildId!;
        const ch  = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel;
        serverLogChannels.set(gid, ch.id);
        await interaction.deferReply();
        await pool.query(
          `INSERT INTO server_log_config (guild_id, channel_id) VALUES ($1, $2)
           ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
          [gid, ch.id]
        );
        await interaction.editReply(`✅ Server log channel set to ${ch}.\nI'll log: message edits/deletes, member join/leave, role & nickname changes.\nUse \`/removeserverlog\` to stop.`);
        return;
      }

      // ── /removeserverlog ───────────────────────────────────────────────────
      if (commandName === "removeserverlog") {
        const gid = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (serverLogChannels.has(gid)) {
          serverLogChannels.delete(gid);
          await pool.query(`DELETE FROM server_log_config WHERE guild_id = $1`, [gid]);
          await interaction.editReply("✅ Server log channel removed.");
        } else {
          await interaction.editReply("No server log channel was set.");
        }
        return;
      }

      // ── /setlog ────────────────────────────────────────────────────────────
      if (commandName === "setlog") {
        const gid = interaction.guildId!;
        const ch  = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel;
        logChannels.set(gid, ch.id);
        await interaction.deferReply();
        await pool.query(
          `INSERT INTO security_log_config (guild_id, channel_id) VALUES ($1, $2)
           ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
          [gid, ch.id]
        );
        await interaction.editReply(`✅ Security alert log set to ${ch}.\nI'll alert on: mass-joins, repeated mentions, link spam, and other threats.`);
        return;
      }

      // ── /removelog ─────────────────────────────────────────────────────────
      if (commandName === "removelog") {
        const gid = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (logChannels.has(gid)) {
          logChannels.delete(gid);
          await pool.query(`DELETE FROM security_log_config WHERE guild_id = $1`, [gid]);
          await interaction.editReply("✅ Security alert log removed.");
        } else {
          await interaction.editReply("No security log channel was set.");
        }
        return;
      }

      // ── /securitystatus ────────────────────────────────────────────────────
      if (commandName === "securitystatus") {
        const gid    = interaction.guildId!;
        const logCh  = logChannels.get(gid);
        const embed  = new EmbedBuilder()
          .setTitle("🛡️ Auto-Security Status")
          .setColor(logCh ? 0x00b894 : 0xd63031)
          .addFields(
            { name: "Alert Channel", value: logCh ? `<#${logCh}>` : "Not set", inline: true },
            { name: "Protections Active", value: "Mass-join • Mention spam • Link flood • Mass-delete", inline: false },
          );
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // ── /hide (steganography) ──────────────────────────────────────────────
      if (commandName === "hide") {
        const secretMsg = interaction.options.getString("message", true);
        const attachment = interaction.options.getAttachment("image", true);
        const key = interaction.options.getString("key") ?? undefined;
        if (!attachment.contentType?.startsWith("image/")) {
          await interaction.reply({ content: "❌ Please attach a PNG/JPG image.", flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await hideInImage(secretMsg, attachment.url, key);
        const file = new AttachmentBuilder(result.buffer, { name: "hidden.png" });
        const keyNote = result.isDefaultKey ? "" : " (custom key required to reveal)";
        await interaction.editReply({
          content: `✅ Message hidden inside the image${keyNote}.\nShare the image below — only someone using \`/reveal\` can extract it.`,
          files: [file],
        });
        return;
      }

      // ── /reveal (steganography) ────────────────────────────────────────────
      if (commandName === "reveal") {
        const attachment = interaction.options.getAttachment("image", true);
        const key = interaction.options.getString("key") ?? undefined;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await revealFromImage(attachment.url, key);
        if (result === "not_found") {
          await interaction.editReply("🔍 No hidden message found in this image."); return;
        }
        if (result === "encrypted") {
          await interaction.editReply("🔐 A message was found but it appears to be encrypted with a custom key. Use the `/reveal key:` option to decrypt it."); return;
        }
        await interaction.editReply(`🔍 **Hidden message revealed:**\n> ${result}`);
        return;
      }

      // ── /profile ───────────────────────────────────────────────────────────
      if (commandName === "profile") {
        const target = interaction.options.getUser("user", true);
        const gid    = interaction.guildId!;
        await interaction.deferReply();
        await flushPending();
        const row = await loadProfile(target.id, gid);
        if (!row) { await interaction.editReply(`❌ No data found for **${target.username}** — they haven't been active yet.`); return; }
        const report = await generateProfileReport(row, target.tag ?? target.username);
        const embed = new EmbedBuilder()
          .setTitle(`🧠 Behavioural Profile — ${target.username}`)
          .setThumbnail(target.displayAvatarURL())
          .setColor(0x6c5ce7)
          .setDescription(report)
          .addFields(
            { name: "Messages", value: String(row.msg_count), inline: true },
            { name: "Commands", value: String(row.cmd_count), inline: true },
            { name: "Peak Hours", value: peakHours(row.hour_counts), inline: true },
          );
        const repCh = reportChannels.get(gid);
        if (repCh) {
          const logChannel = await client.channels.fetch(repCh).catch(() => null) as TextChannel | null;
          await logChannel?.send({ content: `📋 Profile for ${target.tag ?? target.username} requested by ${interaction.user.tag}`, embeds: [embed] }).catch(() => {});
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /myprofile ─────────────────────────────────────────────────────────
      if (commandName === "myprofile") {
        const gid = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await flushPending();
        const row = await loadProfile(interaction.user.id, gid);
        if (!row) { await interaction.editReply("❌ No data found yet — keep chatting and check back later!"); return; }
        const embed = new EmbedBuilder()
          .setTitle(`📊 Your Stats — ${interaction.user.username}`)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setColor(0x00b894)
          .addFields(
            { name: "Messages", value: String(row.msg_count), inline: true },
            { name: "Commands", value: String(row.cmd_count), inline: true },
            { name: "Peak Hours", value: peakHours(row.hour_counts), inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /setprofilechannel ─────────────────────────────────────────────────
      if (commandName === "setprofilechannel") {
        const gid = interaction.guildId!;
        const ch  = interaction.options.getChannel("channel") as TextChannel | null;
        await interaction.deferReply();
        await setReportChannel(gid, ch?.id ?? null);
        await interaction.editReply(ch ? `✅ Profile reports will be logged in ${ch}.` : "✅ Profile report logging disabled.");
        return;
      }

      // ── /briefing ──────────────────────────────────────────────────────────
      if (commandName === "briefing") {
        const gid  = interaction.guildId!;
        const name = interaction.guild?.name ?? gid;
        await interaction.deferReply();
        const text = await generateBriefing(gid, name);
        // generateBriefing already includes its own header — don't double-prefix
        await interaction.editReply(text);
        return;
      }

      // ── /setreport ─────────────────────────────────────────────────────────
      if (commandName === "setreport") {
        const gid = interaction.guildId!;
        const ch  = interaction.options.getChannel("channel") as TextChannel | null;
        await interaction.deferReply();
        if (ch) {
          await setReportChannelId(gid, ch.id);
          await interaction.editReply(`✅ Daily briefing reports will be sent to ${ch}.`);
        } else {
          await pool.query(`DELETE FROM sentiment_config WHERE guild_id = $1`, [gid]);
          await interaction.editReply("✅ Daily briefing reports disabled.");
        }
        return;
      }

      // ── /trackchannel ──────────────────────────────────────────────────────
      if (commandName === "trackchannel") {
        const gid = interaction.guildId!;
        const ch  = interaction.options.getChannel("channel") as TextChannel | null;
        await interaction.deferReply();
        if (!ch) {
          const { rows } = await pool.query(`SELECT channel_id FROM tracker_channels WHERE guild_id = $1`, [gid]);
          const cur = rows[0]?.channel_id;
          await interaction.editReply(cur ? `📡 Current tracker channel: <#${cur}>` : "📡 No tracker channel set. Use `/trackchannel channel:#channel` to set one."); return;
        }
        await pool.query(`INSERT INTO tracker_channels (guild_id, channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id`, [gid, ch.id]);
        await interaction.editReply(`✅ Anime/manga release notifications will be sent to ${ch}.`);
        return;
      }

      // ── /track ─────────────────────────────────────────────────────────────
      if (commandName === "track") {
        const gid  = interaction.guildId!;
        const type = interaction.options.getString("type", true) as "anime" | "manga";
        const name = interaction.options.getString("name", true);
        await interaction.deferReply();
        const { rows: chRows } = await pool.query(`SELECT channel_id FROM tracker_channels WHERE guild_id = $1`, [gid]);
        if (!chRows[0]) {
          await interaction.editReply("⚠️ Set a notification channel first with `/trackchannel`."); return;
        }
        const result = await searchAndTrackTitle(gid, type, name, interaction.user.id);
        if (typeof result === "string") { await interaction.editReply(result); return; }
        await interaction.editReply({ embeds: [result] });
        return;
      }

      // ── /untrack ───────────────────────────────────────────────────────────
      if (commandName === "untrack") {
        const gid  = interaction.guildId!;
        const name = interaction.options.getString("name", true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const exact = await pool.query(
          `DELETE FROM tracked_titles WHERE guild_id = $1 AND LOWER(name) = LOWER($2) RETURNING name`,
          [gid, name],
        );
        if (exact.rowCount && exact.rowCount > 0) {
          await interaction.editReply(`🗑️ Stopped tracking **${exact.rows[0].name}**.`); return;
        }
        const fuzzy = await pool.query(
          `SELECT id, name FROM tracked_titles WHERE guild_id = $1 AND LOWER(name) LIKE LOWER($2)`,
          [gid, `%${name}%`],
        );
        if (!fuzzy.rowCount || fuzzy.rowCount === 0) { await interaction.editReply(`❌ No tracked title found matching **${name}**.`); return; }
        if (fuzzy.rowCount > 1) {
          const list = fuzzy.rows.map((r: any) => `• **${r.name}**`).join("\n");
          await interaction.editReply(`⚠️ Multiple matches for "${name}" — be more specific:\n${list}`); return;
        }
        await pool.query(`DELETE FROM tracked_titles WHERE id = $1`, [fuzzy.rows[0].id]);
        await interaction.editReply(`🗑️ Stopped tracking **${fuzzy.rows[0].name}**.`);
        return;
      }

      // ── /tracklist ─────────────────────────────────────────────────────────
      if (commandName === "tracklist") {
        const gid = interaction.guildId!;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { rows } = await pool.query(`SELECT type, name FROM tracked_titles WHERE guild_id = $1 ORDER BY type, name`, [gid]);
        if (!rows.length) { await interaction.editReply("📭 Nothing is being tracked yet. Use `/track` to add anime/manga."); return; }
        const anime = rows.filter((r: any) => r.type === "anime").map((r: any) => `🎬 **${r.name}**`).join("\n") || "—";
        const manga = rows.filter((r: any) => r.type === "manga").map((r: any) => `📖 **${r.name}**`).join("\n") || "—";
        const embed = new EmbedBuilder()
          .setTitle("📡 Tracking List").setColor(0x7289da)
          .setDescription(`${anime}\n\n${manga}`)
          .setFooter({ text: `${rows.length} title(s)` });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /countdown ─────────────────────────────────────────────────────────
      if (commandName === "countdown") {
        const name = interaction.options.getString("name", true);
        await interaction.deferReply();
        const result = await anilistCountdown(name);
        await interaction.editReply(result);
        return;
      }

      // ── /privacy ───────────────────────────────────────────────────────────
      if (commandName === "privacy") {
        const notice = getPrivacyNotice();
        await interaction.reply({ content: notice, flags: MessageFlags.Ephemeral });
        return;
      }

      // ── /accept ────────────────────────────────────────────────────────────
      if (commandName === "accept") {
        const uid = interaction.user.id;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (await hasConsented(uid)) {
          await interaction.editReply("✅ You have already accepted the privacy notice."); return;
        }
        await acceptConsent(uid);
        await interaction.editReply("✅ Thank you! Behavioural profiling is now enabled for your account.");
        return;
      }

      // ── /say ───────────────────────────────────────────────────────────────
      if (commandName === "say") {
        const text = interaction.options.getString("text", true);
        const ch   = interaction.channel as TextChannel;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await ch.send(text);
        await interaction.editReply("✅ Sent.");
        return;
      }

      // ── /role ──────────────────────────────────────────────────────────────
      if (commandName === "role") {
        const target = interaction.options.getMember("user") as GuildMember | null;
        const role   = interaction.options.getRole("role");
        if (!target || !role) { await interaction.reply({ content: "❌ Invalid user or role.", flags: MessageFlags.Ephemeral }); return; }
        await interaction.deferReply();
        if (target.roles.cache.has(role.id)) {
          await target.roles.remove(role.id);
          await interaction.editReply(`✅ Removed role **${role.name}** from **${target.user.username}**.`);
        } else {
          await target.roles.add(role.id);
          await interaction.editReply(`✅ Added role **${role.name}** to **${target.user.username}**.`);
        }
        return;
      }

      // ── /chat ──────────────────────────────────────────────────────────────
      if (commandName === "chat") {
        const chId = interaction.channelId;
        const on   = interaction.options.getString("state", true) === "on";
        await interaction.deferReply();
        if (on) {
          await addChatChannel(chId);
        } else {
          await removeChatChannel(chId);
        }
        await interaction.editReply(`✅ AI auto-chat ${on ? "**enabled**" : "**disabled**"} in this channel.`);
        return;
      }

      // ── /feature ───────────────────────────────────────────────────────────
      if (commandName === "feature") {
        // Feature flags are GLOBAL (affect all servers) — only the bot owner can change them.
        // Server admins cannot use this command regardless of their server permissions.
        if (!isBotOwner(interaction.user.id)) {
          await interaction.reply({
            content: "🔒 **Access denied.** Only the bot owner can manage global features.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const name  = interaction.options.getString("name", true);
        const on    = interaction.options.getString("state", true) === "on";
        const featureDef = FEATURE_REGISTRY.find(f => f.key === name);
        if (!featureDef) {
          const keys = FEATURE_REGISTRY.map(f => f.key).join(", ");
          await interaction.reply({ content: `❌ Unknown feature \`${name}\`. Known features: ${keys}`, flags: MessageFlags.Ephemeral }); return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const changed = await setFeatureEnabled(name, on, interaction.user.id);
        if (!changed) {
          await interaction.editReply(`❌ Cannot disable essential feature \`${name}\`.`); return;
        }
        await interaction.editReply(`✅ Feature \`${name}\` ${on ? "**enabled**" : "**disabled**"} globally across all servers.`);
        return;
      }

      // ── /clearchat ────────────────────────────────────────────────────────
      if (commandName === "clearchat") {
        const scope          = interaction.options.getString("scope") ?? "channel";
        const deleteMessages = interaction.options.getBoolean("delete_messages") ?? false;
        const msgLimit       = interaction.options.getInteger("limit") ?? 100;
        const gid            = interaction.guildId!;
        const chId           = interaction.channelId;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const results: string[] = [];

        // ── Step 1: Clear AI memory based on scope ──────────────────────────
        if (scope === "user") {
          const target = interaction.options.getUser("user");
          if (!target) { await interaction.editReply("❌ Specify a user with the `user` option when using scope: user."); return; }
          clearHistory(target.id, gid);
          await clearMemory(target.id, gid);
          results.push(`✅ Cleared AI memory for **${target.username}**`);

        } else if (scope === "guild") {
          const guild = interaction.guild;
          if (!guild) { await interaction.editReply("❌ Server only."); return; }
          clearGuildHistory(gid);
          await pool.query(`DELETE FROM user_memory WHERE guild_id = $1`, [gid]);
          results.push(`🌐 Cleared ALL AI memory for **${guild.name}**`);

        } else if (scope === "channel") {
          clearGuildHistory(gid);
          results.push(`🔄 Cleared AI conversation memory`);

        } else if (scope === "none") {
          results.push(`🚫 Skipped AI memory (scope: none)`);
        }

        // ── Step 2: Delete bot messages from this channel ───────────────────
        if (deleteMessages) {
          const ch = interaction.channel as TextChannel | null;
          if (!ch || !("messages" in ch)) {
            results.push("⚠️ Cannot delete messages — channel not accessible");
          } else {
            let deleted = 0;
            let errors  = 0;
            let lastId: string | undefined;
            const cutoff14d = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14-day Discord limit for bulk delete
            const toDeleteOld: import("discord.js").Message[] = [];
            const toDeleteBulk: import("discord.js").Message[] = [];
            let scanned = 0;
            const maxScan = Math.min(msgLimit * 5, 2000); // scan up to 5× limit to find bot msgs

            // Collect bot messages
            while (scanned < maxScan && (deleted + toDeleteBulk.length + toDeleteOld.length) < msgLimit) {
              const fetched = await ch.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) }).catch(() => null);
              if (!fetched || !fetched.size) break;

              for (const [, msg] of fetched) {
                if (msg.author.id === client.user!.id) {
                  if (msg.createdTimestamp > cutoff14d) {
                    toDeleteBulk.push(msg);
                  } else {
                    toDeleteOld.push(msg);
                  }
                  if (toDeleteBulk.length + toDeleteOld.length >= msgLimit) break;
                }
              }

              lastId = fetched.last()?.id;
              scanned += fetched.size;
              if (fetched.size < 100) break;
            }

            // Bulk delete recent messages (< 14 days) in chunks of 100
            const bulkChunks: import("discord.js").Message[][] = [];
            for (let i = 0; i < toDeleteBulk.length; i += 100) bulkChunks.push(toDeleteBulk.slice(i, i + 100));
            for (const chunk of bulkChunks) {
              try {
                if (chunk.length === 1) {
                  await chunk[0].delete();
                } else {
                  await ch.bulkDelete(chunk, true);
                }
                deleted += chunk.length;
              } catch { errors += chunk.length; }
            }

            // Delete old messages one by one (rate-limited)
            for (const msg of toDeleteOld) {
              try {
                await msg.delete();
                deleted++;
                await new Promise(r => setTimeout(r, 600)); // ~1.6/s to avoid rate limit
              } catch { errors++; }
            }

            const oldNote = toDeleteOld.length
              ? ` (${toDeleteOld.length} older than 14 days deleted individually)`
              : "";
            if (errors) {
              results.push(`🗑️ Deleted **${deleted}** bot message(s)${oldNote} — ⚠️ ${errors} failed (no perms or already deleted)`);
            } else {
              results.push(`🗑️ Deleted **${deleted}** bot message(s)${oldNote}`);
            }
          }
        }

        await interaction.editReply(results.join("\n"));
        return;
      }

      // ── /event ────────────────────────────────────────────────────────────
      if (commandName === "event") {
        const sub = interaction.options.getSubcommand();
        const gid = interaction.guildId!;

        // ── /event create ──────────────────────────────────────────────────
        if (sub === "create") {
          const title       = interaction.options.getString("title", true);
          const datetimeStr = interaction.options.getString("datetime", true);
          const desc        = interaction.options.getString("description") ?? null;
          const ch          = (interaction.options.getChannel("channel") ?? interaction.channel) as TextChannel;
          const type        = (interaction.options.getString("type") ?? "event") as EventType;
          const recurring   = (interaction.options.getString("recurring") ?? "none") as RecurType;
          const role        = interaction.options.getRole("role");
          const banner      = interaction.options.getString("banner") ?? null;

          const eventAt = parseEventDate(datetimeStr);
          if (!eventAt) {
            await interaction.reply({ content: "❌ Invalid date format. Use `YYYY-MM-DD HH:MM` or `DD/MM/YYYY HH:MM`.\nExample: `2026-04-01 20:00`", flags: MessageFlags.Ephemeral }); return;
          }
          if (eventAt.getTime() < Date.now()) {
            await interaction.reply({ content: "❌ The event date must be in the future.", flags: MessageFlags.Ephemeral }); return;
          }
          if (title.length > 100) {
            await interaction.reply({ content: "❌ Title too long (max 100 characters).", flags: MessageFlags.Ephemeral }); return;
          }

          await interaction.deferReply();
          const ev = await createEvent({
            guildId:    gid,
            channelId:  ch.id,
            title,
            description: desc,
            eventAt,
            createdBy:  interaction.user.id,
            pingRoleId: role?.id ?? null,
            bannerUrl:  banner,
            type,
            recurring,
          });

          const embed = buildEventEmbed(ev, true);
          const typeEmoji: Record<string, string> = { event:"📅", game:"🎮", tournament:"🏆", watch:"📺", other:"📌" };
          await interaction.editReply({
            content: `${typeEmoji[type] ?? "📅"} **Event created!** Reminders will fire at: 24h, 1h, 10min, and at start.`,
            embeds: [embed],
          });
          return;
        }

        // ── /event list ───────────────────────────────────────────────────
        if (sub === "list") {
          const page   = (interaction.options.getInteger("page") ?? 1) - 1;
          await interaction.deferReply();
          const events = await listEvents(gid, page);

          if (!events.length) {
            await interaction.editReply(page === 0
              ? "📭 No upcoming events. Use `/event create` to schedule one!"
              : "📭 No events on this page.");
            return;
          }

          const typeEmoji: Record<string, string> = { event:"📅", game:"🎮", tournament:"🏆", watch:"📺", other:"📌" };
          const lines = events.map(e => {
            const ts = Math.floor(new Date(e.event_at).getTime() / 1000);
            const emoji = typeEmoji[e.type] ?? "📌";
            const rec = e.recurring !== "none" ? ` 🔄${e.recurring}` : "";
            return `**[${e.id}]** ${emoji} **${e.title}** — <t:${ts}:F> (<t:${ts}:R>)${rec}`;
          }).join("\n");

          const embed = new EmbedBuilder()
            .setTitle(`📋 Upcoming Events — Page ${page + 1}`)
            .setColor(0x9b59b6)
            .setDescription(lines)
            .setFooter({ text: `${events.length} event(s) • Use /event info <id> for details` });

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        // ── /event info ───────────────────────────────────────────────────
        if (sub === "info") {
          const id = interaction.options.getInteger("id", true);
          await interaction.deferReply();
          const ev = await getEvent(id, gid);
          if (!ev) { await interaction.editReply(`❌ No event found with ID **${id}** in this server.`); return; }
          await interaction.editReply({ embeds: [buildEventEmbed(ev, true)] });
          return;
        }

        // ── /event delete ─────────────────────────────────────────────────
        if (sub === "delete") {
          const id     = interaction.options.getInteger("id", true);
          const member = interaction.member as GuildMember;
          const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const ev = await getEvent(id, gid);
          if (!ev) { await interaction.editReply(`❌ No event with ID **${id}**.`); return; }
          if (!isAdmin && ev.created_by !== interaction.user.id) {
            await interaction.editReply("❌ Only the creator or an Admin can delete this event."); return;
          }
          await deleteEvent(id, gid);
          await interaction.editReply(`🗑️ Event **${ev.title}** (ID: ${id}) has been deleted.`);
          return;
        }

        // ── /event edit ───────────────────────────────────────────────────
        if (sub === "edit") {
          const id     = interaction.options.getInteger("id", true);
          const member = interaction.member as GuildMember;
          const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
          const ev = await getEvent(id, gid);
          if (!ev) { await interaction.reply({ content: `❌ No event with ID **${id}**.`, flags: MessageFlags.Ephemeral }); return; }
          if (!isAdmin && ev.created_by !== interaction.user.id) {
            await interaction.reply({ content: "❌ Only the creator or an Admin can edit this event.", flags: MessageFlags.Ephemeral }); return;
          }

          const newTitle   = interaction.options.getString("title")       ?? undefined;
          const newDesc    = interaction.options.getString("description"); // null = not provided
          const newDtStr   = interaction.options.getString("datetime")    ?? undefined;
          const newCh      = interaction.options.getChannel("channel") as TextChannel | null;
          const newRole    = interaction.options.getRole("role");
          const newType    = (interaction.options.getString("type")      ?? undefined) as EventType | undefined;
          const newRecur   = (interaction.options.getString("recurring") ?? undefined) as RecurType | undefined;

          let newEventAt: Date | undefined;
          if (newDtStr) {
            newEventAt = parseEventDate(newDtStr) ?? undefined;
            if (!newEventAt) { await interaction.reply({ content: "❌ Invalid datetime format.", flags: MessageFlags.Ephemeral }); return; }
            if (newEventAt.getTime() < Date.now()) { await interaction.reply({ content: "❌ New date must be in the future.", flags: MessageFlags.Ephemeral }); return; }
          }

          const hasChanges = newTitle || newDesc !== null || newEventAt || newCh || newRole !== null || newType || newRecur;
          if (!hasChanges) { await interaction.reply({ content: "⚠️ No changes provided.", flags: MessageFlags.Ephemeral }); return; }

          await interaction.deferReply();
          const updated = await editEvent(id, gid, {
            title:       newTitle,
            description: newDesc !== null ? newDesc : undefined,
            eventAt:     newEventAt,
            channelId:   newCh?.id,
            pingRoleId:  newRole ? newRole.id : undefined,
            type:        newType,
            recurring:   newRecur,
          });

          if (!updated) { await interaction.editReply("❌ Failed to update event."); return; }
          await interaction.editReply({ content: "✅ Event updated!", embeds: [buildEventEmbed(updated, true)] });
          return;
        }
        return;
      }

      // ── /daily ─────────────────────────────────────────────────────────────
      if (commandName === "daily") {
        const gid = interaction.guildId!;
        const ch  = interaction.options.getChannel("channel") as TextChannel | null;
        await interaction.deferReply();
        if (!ch) {
          const { rows } = await pool.query(`SELECT channel_id FROM daily_config WHERE guild_id=$1`, [gid]);
          const cur = rows[0]?.channel_id;
          await interaction.editReply(cur
            ? `🌅 Daily inspiration channel: <#${cur}>\n\n📅 **Auto-send schedule (UTC+3):**\n🌅 **08:00** — Good Morning\n⛩️ **14:00** — Anime Quote\n🌙 **18:00** — Evening Wisdom\n✨ **23:00** — Night Reflection`
            : "🌅 No daily inspiration channel set. Use `/daily channel:#channel` to configure one."
          ); return;
        }
        await pool.query(
          `INSERT INTO daily_config (guild_id, channel_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id`,
          [gid, ch.id],
        );
        await interaction.editReply(
          `✅ Daily inspiration messages will be sent to ${ch}\n\n📅 **Auto-send schedule (UTC+3):**\n🌅 **08:00** — Good Morning\n⛩️ **14:00** — Anime Quote\n🌙 **18:00** — Evening Wisdom\n✨ **23:00** — Night Reflection`
        );
        return;
      }

      // ── /autofix ───────────────────────────────────────────────────────────
      if (commandName === "autofix") {
        // Auto-fix is global (patches the bot's own source code) — bot-owner only.
        if (!isBotOwner(interaction.user.id)) {
          await interaction.reply({
            content: "🔒 **Access denied.** Only the bot owner can manage the auto-fix engine.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const sub = interaction.options.getSubcommand(true);

        if (sub === "enable") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await setAutoFixEnabled(true);
          await interaction.editReply([
            "🧬 **Auto-Fix Engine ENABLED**",
            "",
            "The bot will now watch for recurring errors. When the same error occurs **3 times within 10 minutes**, it will:",
            "1. 🤖 Use Gemini AI to read the source code and generate a surgical fix",
            "2. ✅ Validate the fix with TypeScript",
            "3. 🔨 Rebuild the bot",
            "4. ♻️ Restart itself (dev) — patch saved to DB",
            "5. 🔄 Production auto-applies the patch on next startup (≤30 min) — **no manual action needed**",
            "6. 📢 Report here with full fix details",
            "",
            "⚠️ Make sure `/sethealthchannel` is configured to receive fix reports.",
          ].join("\n"));
          return;
        }

        if (sub === "disable") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await setAutoFixEnabled(false);
          await interaction.editReply("🔒 **Auto-Fix Engine DISABLED**\nErrors are still monitored and reported, but no code changes will be made.");
          return;
        }

        if (sub === "status") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const history = await getFixHistory(5);
          const statusLine = autoFixEnabled
            ? "🟢 **ENABLED** — Bot will auto-patch code on recurring errors"
            : "🔴 **DISABLED** — Errors reported only, no code changes";

          const embed = new EmbedBuilder()
            .setTitle("🧬 Auto-Fix Engine Status")
            .setColor(autoFixEnabled ? 0x00b894 : 0x636e72)
            .setDescription(statusLine)
            .setTimestamp();

          if (history.length) {
            for (const fix of history) {
              const ts     = `<t:${Math.floor(new Date(fix.appliedAt).getTime() / 1000)}:R>`;
              const icon   = fix.status === "applied" ? "✅" : "❌";
              const detail = fix.status === "applied"
                ? fix.description
                : `${fix.status} — ${fix.description}`;
              embed.addFields({
                name:   `${icon} ${fix.errorKey.slice(0, 60)} ${ts}`,
                value:  detail.slice(0, 300),
                inline: false,
              });
            }
          } else {
            embed.addFields({ name: "📋 History", value: "No fix attempts yet", inline: false });
          }

          await interaction.editReply({ embeds: [embed] });
          return;
        }
        return;
      }

      // ── /health ────────────────────────────────────────────────────────────
      if (commandName === "health") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const health = await getHealthStatus();
        const embed  = buildHealthEmbed(health);
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /sethealthchannel ──────────────────────────────────────────────────
      if (commandName === "sethealthchannel") {
        const ch = interaction.options.getChannel("channel") as TextChannel | null;
        await interaction.deferReply();
        await setHealthChannel(ch?.id ?? null);
        if (ch) {
          await interaction.editReply(`✅ Bot health reports and error alerts will be sent to ${ch}.\nUse \`/health\` anytime for a live status check.`);
        } else {
          await interaction.editReply("✅ Health channel removed. No more auto-reports.");
        }
        return;
      }

      // ── /errors ────────────────────────────────────────────────────────────
      if (commandName === "errors") {
        const limit  = interaction.options.getInteger("limit") ?? 5;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const errs = await getRecentErrors(limit);
        if (!errs.length) {
          await interaction.editReply("✅ No errors logged yet — the bot is clean!");
          return;
        }
        const embed = new EmbedBuilder()
          .setTitle(`🔍 Last ${errs.length} Error(s)`)
          .setColor(0x6c5ce7)
          .setTimestamp();
        for (const e of errs) {
          const ts    = `<t:${Math.floor(new Date(e.occurredAt).getTime() / 1000)}:R>`;
          const fixed = e.autoFixed ? "🔧 Auto-fixed" : "⚠️ Manual fix needed";
          embed.addFields({
            name:   `[${e.category.toUpperCase()}] ${e.errorMsg.slice(0, 60)} ${ts}`,
            value:  `${fixed}\n**Analysis:** ${e.analysis.slice(0, 200)}\n**Suggestion:** ${e.suggestion.slice(0, 150)}`,
            inline: false,
          });
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // ── /build (removed) ──────────────────────────────────────────────────
      if (commandName === "build") {
        await interaction.reply({ content: "⚠️ `/build` has been removed from this bot.", flags: MessageFlags.Ephemeral });
        return;
      }

      // ── /security ──────────────────────────────────────────────────────────
      if (commandName === "security") {
        const sub = interaction.options.getSubcommand(true);

        if (sub === "scan") {
          const rl = checkRateLimit(interaction.user.id, "security");
          if (!rl.allowed) {
            await interaction.reply({ content: `⏳ Security scan is rate limited. Try again in **${rl.retryAfterSec}s**.`, flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          // Show immediate progress so the user knows the bot is working
          await interaction.editReply({
            embeds: [new EmbedBuilder()
              .setColor(0xf39c12)
              .setTitle("🔍 Security Scan Running...")
              .setDescription("Gemini AI is auditing the bot code for vulnerabilities.\n\n⏳ This may take **30–90 seconds** — please wait...")
              .setTimestamp()],
          });

          // 120-second timeout — long enough for Gemini but prevents forever-hanging
          const SCAN_TIMEOUT = 120_000;
          let vulns: Awaited<ReturnType<typeof runSecurityScan>>;
          try {
            vulns = await Promise.race([
              runSecurityScan(),
              new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error("Security scan timed out after 120s")), SCAN_TIMEOUT)),
            ]);
          } catch (scanErr: any) {
            await interaction.editReply({
              embeds: [new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle("❌ Security Scan Failed")
                .setDescription(`The scan did not complete:\n\`\`\`${String(scanErr?.message ?? scanErr).slice(0, 400)}\`\`\`\nPlease try again in a few minutes.`)
                .setTimestamp()],
            });
            return;
          }

          const embed = new EmbedBuilder()
            .setColor(vulns.length === 0 ? 0x00d26a : vulns.some(v => v.severity === "CRITICAL") ? 0xff0000 : 0xff9f43)
            .setTitle(`🔍 Security Scan — ${vulns.length} Issue(s) Found`)
            .setTimestamp();

          if (!vulns.length) {
            embed.setDescription("✅ No vulnerabilities detected! The bot code looks clean.");
          } else {
            const byLevel = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
            for (const v of vulns) byLevel[v.severity as keyof typeof byLevel]++;
            embed.setDescription(
              `🔴 Critical: **${byLevel.CRITICAL}** · 🟠 High: **${byLevel.HIGH}** · 🟡 Medium: **${byLevel.MEDIUM}** · 🟢 Low: **${byLevel.LOW}**\n\nRun **/security harden** to auto-fix these.`
            );
            for (const v of vulns.slice(0, 8)) {
              const icon = v.severity === "CRITICAL" ? "🔴" : v.severity === "HIGH" ? "🟠" : v.severity === "MEDIUM" ? "🟡" : "🟢";
              embed.addFields({ name: `${icon} ${v.severity} — ${v.file.split("/").pop()}`, value: `${v.description.slice(0, 150)}\n💡 ${v.suggestion.slice(0, 100)}`, inline: false });
            }
          }
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        if (sub === "harden") {
          const rl = checkRateLimit(interaction.user.id, "security");
          if (!rl.allowed) {
            await interaction.reply({ content: `⏳ Try again in **${rl.retryAfterSec}s**.`, flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const result = await hardenSecurity();

          const embed = new EmbedBuilder()
            .setColor(result.fixed > 0 ? 0x00d26a : 0xff9f43)
            .setTitle(`🔒 Security Hardening — ${result.fixed} Fix(es) Applied`)
            .setDescription(result.details.join("\n").slice(0, 2000))
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        if (sub === "status") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const status = await getSecurityStatus();
          const embed = new EmbedBuilder()
            .setColor(0x6c5ce7)
            .setTitle("🛡️ Security Status")
            .addFields(
              { name: "Last Scan", value: status.lastScan ? `<t:${Math.floor(status.lastScan.getTime()/1000)}:R>` : "Never", inline: true },
              { name: "Vulnerabilities Found", value: String(status.vulnCount), inline: true },
              { name: "Fixed", value: String(status.fixed), inline: true },
              { name: "Last Hardened", value: status.hardenedAt ? `<t:${Math.floor(status.hardenedAt.getTime()/1000)}:R>` : "Never", inline: true },
              { name: "Rate Limiting", value: "✅ Active — 20 cmds/min global", inline: true },
              { name: "Input Sanitization", value: "✅ Active — all inputs sanitized", inline: true },
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
      }

      // ── /resetplugins ──────────────────────────────────────────────────────
      if (commandName === "resetplugins") {
        if (!interaction.guildId) {
          await interaction.reply({ content: "❌ هذا الأمر يعمل داخل السيرفرات فقط.", flags: MessageFlags.Ephemeral });
          return;
        }
        // Count how many plugins belong to this guild
        const guildPlugins = aiPluginCommands.filter(p => p.guildId === interaction.guildId);

        if (guildPlugins.length === 0) {
          await interaction.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x00d26a)
              .setTitle("✅ لا يوجد ما يُحذف")
              .setDescription("لا توجد أي أوامر مبنية بالذكاء الاصطناعي مرتبطة بهذا السيرفر.")
              .setTimestamp()],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Show confirmation with a destructive button
        const nameList = guildPlugins.map(p => `\`/${p.name}\``).join(" · ");
        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("resetplugins_confirm")
            .setLabel(`نعم، احذف ${guildPlugins.length} أمر`)
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId("resetplugins_cancel")
            .setLabel("إلغاء")
            .setStyle(ButtonStyle.Secondary),
        );
        await interaction.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("⚠️ تأكيد إعادة الضبط")
            .setDescription(
              `سيتم حذف **${guildPlugins.length}** أمر مبني بالذكاء الاصطناعي من هذا السيرفر نهائياً:\n\n${nameList}\n\n` +
              `> الأوامر العالمية الافتراضية (مثل \`/joke\`) **لن تُمس**.\n` +
              `> هذا الإجراء **لا يمكن التراجع عنه**.`,
            )
            .setTimestamp()],
          components: [confirmRow],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // ── /plugins ───────────────────────────────────────────────────────────
      if (commandName === "plugins") {
        if (!interaction.guildId) {
          await interaction.reply({ content: "❌ Server only.", flags: MessageFlags.Ephemeral });
          return;
        }
        const gid = interaction.guildId;

        // AI-built commands for this guild
        const guildBuilt  = aiPluginCommands.filter(p => p.guildId === gid);
        // Global built-in plugins (joke, news-alerts, etc.)
        const globalBuiltin = aiPluginCommands.filter(p => !p.guildId);

        const totalCount = guildBuilt.length + globalBuiltin.length;

        if (totalCount === 0) {
          await interaction.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x636e72)
              .setTitle("📭 No Plugins Yet")
              .setDescription("No AI-built commands exist in this server yet.\nUse `/build` to create your first one!")
              .setTimestamp()],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x6c5ce7)
          .setTitle(`🔌 Plugin Dashboard — ${totalCount} Plugin(s)`)
          .setTimestamp()
          .setFooter({ text: `${guildBuilt.length} AI-built for this server · ${globalBuiltin.length} global built-ins` });

        // AI-built guild plugins
        if (guildBuilt.length > 0) {
          embed.addFields({
            name: `🧬 AI-Built Commands (${guildBuilt.length}) — This Server Only`,
            value: guildBuilt.map(p => {
              const desc = (p.definition as any).description ?? "(no description)";
              return `**\`/${p.name}\`** — ${desc.slice(0, 80)}`;
            }).join("\n"),
            inline: false,
          });
        }

        // Global built-in plugins
        if (globalBuiltin.length > 0) {
          embed.addFields({
            name: `⭐ Built-in Global Commands (${globalBuiltin.length})`,
            value: globalBuiltin.map(p => {
              const desc = (p.definition as any).description ?? "(no description)";
              return `**\`/${p.name}\`** — ${desc.slice(0, 80)}`;
            }).join("\n"),
            inline: false,
          });
        }

        embed.addFields({
          name: "🧪 Test Buttons",
          value: guildBuilt.length > 0
            ? "Use the buttons below to test each AI-built command with mock inputs.\nIf a command fails, an auto-fix button will appear to patch it with Gemini AI."
            : "No AI-built commands to test yet. Use `/build` to create one.",
          inline: false,
        });

        // Add test buttons for AI-built plugins (max 5 per row, max 25 total)
        const components: ActionRowBuilder<ButtonBuilder>[] = [];
        const testable = guildBuilt.slice(0, 25);
        for (let i = 0; i < testable.length; i += 5) {
          const chunk = testable.slice(i, i + 5);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...chunk.map(p =>
              new ButtonBuilder()
                .setCustomId(`build_test:${p.name}`)
                .setLabel(`🧪 /${p.name}`)
                .setStyle(ButtonStyle.Secondary)
            )
          );
          components.push(row);
        }

        if (guildBuilt.length > 25) {
          embed.addFields({
            name: "ℹ️ Note",
            value: `Showing test buttons for the first 25 commands (${guildBuilt.length} total). Use \`/improve\` to fix specific ones.`,
            inline: false,
          });
        }

        await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
        return;
      }

      // ── AI Plugin commands dispatch ────────────────────────────────────────
      for (const plugin of aiPluginCommands) {
        if (commandName === plugin.name) {
          // Guild isolation: if this plugin is guild-specific, only allow the owning guild
          if (plugin.guildId && interaction.guildId !== plugin.guildId) {
            await interaction.reply({ content: "❌ This command is not available in this server.", flags: MessageFlags.Ephemeral });
            return;
          }
          const rl = checkRateLimit(interaction.user.id, "global");
          if (!rl.allowed) {
            await interaction.reply({ content: `⏳ Too many commands! Try again in **${rl.retryAfterSec}s**.`, flags: MessageFlags.Ephemeral });
            return;
          }
          try {
            await plugin.handler(interaction as ChatInputCommandInteraction);
          } catch (pluginErr) {
            throw pluginErr; // Let outer catch handle selfHeal + user reply
          }
          return;
        }
      }

    } catch (err) {
      console.error(`[Slash] Error handling /${commandName}:`, err);
      selfHealError(err, `slash/${commandName}`, interaction.guildId ?? undefined).catch(console.error);
      const msg = "❌ An error occurred. Please try again.";
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch((replyErr) => {
          console.warn(`[Slash] Could not send error reply for /${commandName}:`, replyErr?.message ?? replyErr);
        });
      } else if (!interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      }
    } finally {
      clearTimeout(safetyTimer);
    }
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function registerSlashCommands(client: Client, token: string): void {
  client.once(Events.ClientReady, async (c) => {
    await registerGlobalCommands(c.application.id, token);
    handleInteractions(client);
  });
}
