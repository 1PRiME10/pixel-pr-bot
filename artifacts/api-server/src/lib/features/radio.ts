import { isClaimed } from "../message-gate.js";
// ─── Radio — powered by @discordjs/voice (FREE, no Lavalink needed) ───────────
// Audio flows: Stream URL → Bot process → Discord Voice (UDP)
// Works out-of-the-box with ffmpeg-static + opusscript already installed.
//
// Commands:
//   !setradio <voice channel> [station]  — configure and start radio (admin)
//   !radioplay                            — resume radio (admin)
//   !radiostop                            — stop and clear config (admin)
//   !radiopause                           — pause without clearing config (admin)
//   !radiostatus                          — show current status
//   !radiostation <key>                   — switch to a built-in station (admin)
//   !stations                             — list all built-in stations
//   !radiosearch <query>                  — search Radio Browser (30k+ stations)
//   1-8                                   — pick from last search results

import {
  Client,
  Events,
  TextChannel,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
  Colors,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  StreamType,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { pool } from "@workspace/db";

// ─── Built-in stations ────────────────────────────────────────────────────────
// All URLs verified reachable from cloud IPs (Render/AWS) — last audit 2026-03-26
export const BUILTIN_STATIONS: Record<string, { name: string; url: string; category: string }> = {
  // ── Music ──────────────────────────────────────────────────────────────────
  lofi:        { name: "Lofi Hip Hop",              url: "https://stream.zeno.fm/f3wvbbqmdg8uv",                                                     category: "music"  },
  synthwave:   { name: "Synthwave Radio",            url: "https://stream.synthwaveradio.eu/listen/synthwaveradio.eu/radio.mp3",                      category: "music"  },
  jazz:        { name: "Smooth Jazz",                url: "https://stream.zeno.fm/0r0xa792kwzuv",                                                     category: "music"  },
  pop:         { name: "SomaFM PopTron — Indie Pop", url: "https://ice1.somafm.com/poptron-128-mp3",                                                  category: "music"  },
  groove:      { name: "Groove Salad",               url: "https://ice1.somafm.com/groovesalad-256-mp3",                                              category: "music"  },
  // ── International News ─────────────────────────────────────────────────────
  bbc:         { name: "BBC World Service",          url: "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service",                                  category: "news"   },
  dw:          { name: "DW English",                 url: "https://dw.audiostream.io/dw/1027/mp3/64/dw08",                                            category: "news"   },
  rfi:         { name: "RFI English",                url: "https://rfi-e-mp3-128.cast.addradio.de/rfi/anglais/all/mp3/128/stream.mp3",                category: "news"   },
  france24:    { name: "France 24 Radio",            url: "https://stream.france24.com/france24-en",                                                  category: "news"   },
  euronews:    { name: "Euronews Radio",             url: "https://euronews-live.streamabc.net/euronews-euronewsradio-mp3-128-6986483",                category: "news"   },
  // ── Arabic News 🌍 ─────────────────────────────────────────────────────────
  aljazeera:   { name: "الجزيرة — Al Jazeera",            url: "https://live-hls-audio-web-aja.getaj.net/VOICE-AJA/index.m3u8",                      category: "arabic" },
  skynews:     { name: "سكاي نيوز عربية",                  url: "https://stream.skynewsarabia.com/hls/sna.m3u8",                                      category: "arabic" },
  mcd:         { name: "مونت كارلو الدولية — MC Doualiya", url: "https://montecarlodoualiya128k.ice.infomaniak.ch/mc-doualiya.mp3",                   category: "arabic" },
  bbcarabic:   { name: "بي بي سي عربية — BBC Arabic",      url: "https://stream.live.vc.bbcmedia.co.uk/bbc_arabic_radio",                            category: "arabic" },
  alarabiya:   { name: "إذاعة العربية — Al Arabiya FM",     url: "https://fm.alarabiya.net/fm/myStream/playlist.m3u8",                               category: "arabic" },
  // ── Japan / Anime ──────────────────────────────────────────────────────────
  nhk:         { name: "NHK World Radio",                  url: "https://b-nhkworld-radio.nhkworld.jp/hls/live/nhkworld-radio-rs1/index_rs1.m3u8",   category: "japan"  },
  jwave:       { name: "J-Wave 81.3 FM Tokyo",             url: "https://musicbird.leanstream.co/JCB079-MP3",                                        category: "japan"  },
  nhkr2:       { name: "NHK World Radio 2",                url: "https://master.nhkworld.jp/nhkworld-radio/playlist/gs2/live.m3u8",                   category: "japan"  },
  animefm:     { name: "Listen.moe — Anime JPOP",          url: "https://listen.moe/fallback",                                                        category: "japan"  },
  animelofi:   { name: "SomaFM Fluid — Chill Electronica", url: "https://ice1.somafm.com/fluid-128-mp3",                                             category: "japan"  },
  japanaradio: { name: "Listen.moe — K-Pop Radio",         url: "https://listen.moe/kpop/fallback",                                                   category: "japan"  },
  animenexus:  { name: "Anime Nexus — Requests & Live",    url: "https://cast.animenexusla.com/radio/8000/animenexus",                                category: "japan"  },
  vocaloid:    { name: "Vocaloid Radio",                   url: "http://curiosity.shoutca.st:8019/stream",                                            category: "japan"  },
  anisonfm:    { name: "MC Anime Radio — Live Requests",   url: "https://cast.mcanimeradio.com/hls/mcradio/live.m3u8",                                category: "japan"  },
};

// ─── Radio Browser API (free — 30k+ stations) ─────────────────────────────────
export interface RBStation {
  stationuuid: string;
  name: string;
  url_resolved: string;
  country: string;
  language: string;
  tags: string;
  bitrate: number;
  clickcount: number;
}
const RB_HOSTS = ["de1.api.radio-browser.info", "nl1.api.radio-browser.info", "at1.api.radio-browser.info"];

export async function searchRadioBrowser(query: string, limit = 8): Promise<RBStation[]> {
  for (const host of RB_HOSTS) {
    try {
      const params = new URLSearchParams({ name: query, limit: String(limit), hidebroken: "true", order: "clickcount", reverse: "true" });
      const res = await fetch(`https://${host}/json/stations/search?${params}`, {
        headers: { "User-Agent": "PIXEL-Discord-Bot/1.0" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as RBStation[];
      if (Array.isArray(data) && data.length > 0) return data;
    } catch { /* try next */ }
  }
  return [];
}

function reportRBClick(uuid: string): void {
  fetch(`https://${RB_HOSTS[0]}/json/url/${uuid}`, { headers: { "User-Agent": "PIXEL-Discord-Bot/1.0" } }).catch(() => {});
}

interface PendingSearch { stations: RBStation[]; expiresAt: number; }
const pendingSearches = new Map<string, PendingSearch>();

// ─── Per-guild state ──────────────────────────────────────────────────────────
export interface RadioState {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  streamUrl: string;
  stationName: string;
  stationKey?: string;
  stopped: boolean;
}
export const radioStates = new Map<string, RadioState>();

// ─── Per-guild audio player ───────────────────────────────────────────────────
// We keep one AudioPlayer per guild; the voice connection subscribes to it.
const audioPlayers = new Map<string, ReturnType<typeof createAudioPlayer>>();

// ─── Per-guild mutex: prevent concurrent startRadio for same guild ────────────
// Rapid station switching (/radiostation x3 in 1 min) without this causes
// multiple concurrent joinVoiceChannel + entersState calls that race each other,
// leaving orphaned listeners and audio resources that pile up until a crash.
const radioStartLock = new Map<string, boolean>();

// ─── Per-guild stream failure tracking ───────────────────────────────────────
// Tracks how many consecutive times a stream URL has failed.  After MAX_RETRIES
// the bot stops retrying silently and posts a warning in the text channel.
const streamFailCount = new Map<string, number>();
const MAX_STREAM_RETRIES = 5;

// Call this whenever the user explicitly changes station — resets the counter.
export function resetStreamFailCount(guildId: string): void {
  streamFailCount.delete(guildId);
}

// ─── initLavalink kept as a no-op for backward compatibility ─────────────────
export function initLavalink(_client: Client): void {
  console.log("[Radio] Using @discordjs/voice (no Lavalink needed — 100% free)");
}

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initRadio(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS radio_config (
      guild_id     TEXT PRIMARY KEY,
      voice_ch_id  TEXT NOT NULL,
      text_ch_id   TEXT NOT NULL,
      stream_url   TEXT NOT NULL DEFAULT 'https://stream.zeno.fm/f3wvbbqmdg8uv',
      station_name TEXT NOT NULL DEFAULT 'Lofi Hip Hop'
    )
  `);
  const { rows } = await pool.query(`SELECT * FROM radio_config`);
  for (const r of rows) {
    radioStates.set(r.guild_id, {
      guildId: r.guild_id,
      voiceChannelId: r.voice_ch_id,
      textChannelId: r.text_ch_id,
      streamUrl: r.stream_url,
      stationName: r.station_name,
      stopped: false,
    });
  }
  console.log(`[Radio] Loaded ${radioStates.size} config(s) from DB`);
}

// ─── Start radio via @discordjs/voice ─────────────────────────────────────────
// Protected by a per-guild mutex so rapid /radiostation switching never spawns
// multiple concurrent joinVoiceChannel calls.  Retry count is capped at
// MAX_STREAM_RETRIES; on final failure the bot posts a warning to the text channel
// instead of looping forever and leaking resources.
export async function startRadio(client: Client, guildId: string): Promise<void> {
  // ── Mutex: skip if already starting for this guild ─────────────────────────
  if (radioStartLock.get(guildId)) {
    console.log(`[Radio] startRadio already in progress for ${guildId} — skipping duplicate call`);
    return;
  }
  radioStartLock.set(guildId, true);

  try {
    const state = radioStates.get(guildId);
    if (!state || state.stopped) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) { console.error(`[Radio] Guild ${guildId} not found`); return; }

    const voiceChannel = guild.channels.cache.get(state.voiceChannelId);
    if (!voiceChannel || voiceChannel.type !== 2) {
      console.error(`[Radio] Voice channel ${state.voiceChannelId} not found or not a voice channel`);
      return;
    }

    // ── Destroy stale connection so we always get a fresh one ──────────────
    // Without this, rapidly switching stations leaves the old connection in an
    // unknown state which causes entersState to time out every time.
    const stale = getVoiceConnection(guildId);
    if (stale) {
      stale.removeAllListeners();
      stale.destroy();
    }
    const oldPlayer = audioPlayers.get(guildId);
    if (oldPlayer) {
      oldPlayer.removeAllListeners();
      oldPlayer.stop(true);
      audioPlayers.delete(guildId);
    }

    // ── Join voice channel ─────────────────────────────────────────────────
    const connection = joinVoiceChannel({
      channelId: state.voiceChannelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    // Wait for connection to be ready (max 12s)
    await entersState(connection, VoiceConnectionStatus.Ready, 12_000);

    // ── Create fresh audio player ──────────────────────────────────────────
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    audioPlayers.set(guildId, player);

    // ── Stream error → retry with capped backoff ───────────────────────────
    player.on("error", (err) => {
      console.error(`[Radio] Player error (${guildId}):`, err.message);
      const fails = (streamFailCount.get(guildId) ?? 0) + 1;
      streamFailCount.set(guildId, fails);
      if (state.stopped) return;
      if (fails > MAX_STREAM_RETRIES) {
        console.warn(`[Radio] Stream "${state.stationName}" failed ${fails}x — giving up. Use /radiostation to switch.`);
        const textCh = client.channels.cache.get(state.textChannelId) as import("discord.js").TextChannel | undefined;
        textCh?.send(`⚠️ Radio stream **${state.stationName}** failed **${fails} times** and is unreachable.\nUse \`/radiostation\` to switch to a working station.`).catch(() => {});
        state.stopped = true;
        return;
      }
      const delay = Math.min(10_000 * fails, 60_000); // 10s, 20s, 30s … max 60s
      console.log(`[Radio] Retry ${fails}/${MAX_STREAM_RETRIES} in ${delay / 1000}s…`);
      setTimeout(() => startRadio(client, guildId), delay);
    });

    // ── Stream ended normally → reconnect with gentle backoff ─────────────
    player.on(AudioPlayerStatus.Idle, () => {
      if (state.stopped) return;
      const fails = streamFailCount.get(guildId) ?? 0;
      const delay = fails > 0 ? Math.min(10_000 * (fails + 1), 60_000) : 5_000;
      console.log(`[Radio] Stream ended (${guildId}), reconnecting in ${delay / 1000}s…`);
      setTimeout(() => startRadio(client, guildId), delay);
    });

    // ── Subscribe and play ─────────────────────────────────────────────────
    connection.subscribe(player);

    const resource = createAudioResource(state.streamUrl, {
      inputType: StreamType.Arbitrary,
      inlineVolume: false,
    });
    player.play(resource);
    // Reset fail counter on successful play start
    streamFailCount.delete(guildId);
    console.log(`[Radio] 📻 Now playing "${state.stationName}" via @discordjs/voice`);

    // ── Handle disconnection (kicked / moved channel) ──────────────────────
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        connection.destroy();
        audioPlayers.delete(guildId);
        if (!state.stopped) setTimeout(() => startRadio(client, guildId), 10_000);
      }
    });

  } catch (err) {
    const state = radioStates.get(guildId);
    console.error(`[Radio] Failed to start (${guildId}):`, (err as Error).message);
    if (state && !state.stopped) {
      const fails = (streamFailCount.get(guildId) ?? 0) + 1;
      streamFailCount.set(guildId, fails);
      if (fails <= MAX_STREAM_RETRIES) {
        const delay = Math.min(15_000 * fails, 60_000);
        setTimeout(() => startRadio(client, guildId), delay);
      } else {
        console.warn(`[Radio] Connection failed ${fails}x for guild ${guildId} — stopping auto-retry`);
        const textCh = client.channels.cache.get(state.textChannelId) as import("discord.js").TextChannel | undefined;
        textCh?.send(`⚠️ Could not connect to voice channel after **${fails} attempts**. Please use \`/radioplay\` to try again.`).catch(() => {});
        state.stopped = true;
      }
    }
  } finally {
    // Always release the mutex, even if we threw
    radioStartLock.delete(guildId);
  }
}

// ─── Stop radio ───────────────────────────────────────────────────────────────
export async function stopRadio(guildId: string): Promise<void> {
  const state = radioStates.get(guildId);
  if (state) state.stopped = true;

  const player = audioPlayers.get(guildId);
  if (player) { player.removeAllListeners(); player.stop(true); audioPlayers.delete(guildId); }

  const conn = getVoiceConnection(guildId);
  if (conn) { conn.removeAllListeners(); conn.destroy(); }

  // Clear retry state so next /radioplay starts fresh
  streamFailCount.delete(guildId);
  radioStartLock.delete(guildId);
}

// ─── Save state to DB ─────────────────────────────────────────────────────────
export async function saveRadioConfig(state: RadioState): Promise<void> {
  await pool.query(
    `INSERT INTO radio_config (guild_id, voice_ch_id, text_ch_id, stream_url, station_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (guild_id) DO UPDATE
     SET voice_ch_id=$2, text_ch_id=$3, stream_url=$4, station_name=$5`,
    [state.guildId, state.voiceChannelId, state.textChannelId, state.streamUrl, state.stationName],
  );
}

// ─── Commands ─────────────────────────────────────────────────────────────────
export function registerRadio(client: Client): void {

  // Auto-resume on bot ready
  client.once(Events.ClientReady, async () => {
    await new Promise(r => setTimeout(r, 5_000)); // wait for voice adapters to init
    for (const state of radioStates.values()) {
      if (!state.stopped) await startRadio(client, state.guildId);
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot || !message.guild) return;
    if (!(await isClaimed(message.id))) return;
    const content = message.content.replace(/<@!?\d+>\s*/g, "").trim().toLowerCase();
    const guildId = message.guild.id;
    const isAdmin = () => message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

    // ── !setradio <voice channel> [station] ───────────────────────────────────
    if (content.startsWith("!setradio")) {
      if (!isAdmin()) { await message.reply("❌ You need **Administrator** permission."); return; }

      const rawArgs = message.content.replace(/<@!?\d+>\s*/g, "").trim().slice("!setradio".length).trim();
      let voiceChId: string | undefined;

      const mentionedCh = message.mentions.channels.first();
      if (mentionedCh?.type === 2) {
        voiceChId = mentionedCh.id;
      } else {
        const tokens = rawArgs.split(/\s+/);
        const chToken = tokens.find(t => !t.match(/^<#\d+>$/)) ?? "";
        if (chToken) {
          const allVoice = message.guild.channels.cache.filter(c => c.type === 2);
          const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
          const needle = norm(chToken);
          voiceChId = (
            allVoice.get(chToken) ??
            allVoice.find(c => c.name.toLowerCase() === chToken.toLowerCase()) ??
            allVoice.find(c => norm(c.name) === needle) ??
            allVoice.find(c => norm(c.name).includes(needle))
          )?.id;
        }
      }

      if (!voiceChId) {
        const list = message.guild.channels.cache.filter(c => c.type === 2).map(c => `\`${c.name}\``).join(", ");
        await message.reply(`❌ Voice channel not found.\n**Usage:** \`!setradio <channel> [station]\`\n\n**Voice channels:** ${list || "none"}`);
        return;
      }

      const chToken = rawArgs.split(/\s+/).find(t => !t.match(/^<#\d+>$/)) ?? "";
      const extra = rawArgs.slice(chToken.length).trim().toLowerCase();
      let streamUrl = BUILTIN_STATIONS.lofi.url, stationName = BUILTIN_STATIONS.lofi.name;

      if (extra) {
        const station = BUILTIN_STATIONS[extra];
        if (station) { streamUrl = station.url; stationName = station.name; }
        else if (extra.startsWith("http")) { streamUrl = extra; stationName = "Custom Stream"; }
        else {
          await message.reply(`❌ Unknown station \`${extra}\`. Use \`!stations\` to see options.`);
          return;
        }
      }

      const state: RadioState = { guildId, voiceChannelId: voiceChId, textChannelId: message.channelId, streamUrl, stationName, stopped: false };
      radioStates.set(guildId, state);
      await saveRadioConfig(state);

      const msg = await message.reply(`📻 Setting up **${stationName}**...`);
      await startRadio(client, guildId);
      await msg.edit(`✅ Radio is ON! Playing **${stationName}** 🎵`);
      return;
    }

    // ── !radioplay ────────────────────────────────────────────────────────────
    if (content === "!radioplay") {
      if (!isAdmin()) { await message.reply("❌ Administrator only."); return; }
      const state = radioStates.get(guildId);
      if (!state) { await message.reply("❌ No radio configured. Use `!setradio <channel>`."); return; }
      state.stopped = false;
      await message.reply("▶️ Starting radio...");
      await startRadio(client, guildId);
      return;
    }

    // ── !radiostop ────────────────────────────────────────────────────────────
    if (content === "!radiostop") {
      if (!isAdmin()) { await message.reply("❌ Administrator only."); return; }
      await stopRadio(guildId);
      await pool.query(`DELETE FROM radio_config WHERE guild_id=$1`, [guildId]);
      radioStates.delete(guildId);
      await message.reply("⏹️ Radio stopped. Use `!setradio` to set up again.");
      return;
    }

    // ── !radiopause ───────────────────────────────────────────────────────────
    if (content === "!radiopause") {
      if (!isAdmin()) { await message.reply("❌ Administrator only."); return; }
      const state = radioStates.get(guildId);
      if (!state) { await message.reply("❌ Radio not configured."); return; }
      await stopRadio(guildId);
      state.stopped = true;
      await message.reply("⏸️ Radio paused. Use `!radioplay` to resume.");
      return;
    }

    // ── !radiostatus ──────────────────────────────────────────────────────────
    if (content === "!radiostatus") {
      const state = radioStates.get(guildId);
      if (!state) { await message.reply("📻 No radio configured."); return; }
      const conn = getVoiceConnection(guildId);
      const player = audioPlayers.get(guildId);
      const live = !!conn && !!player && player.state.status === AudioPlayerStatus.Playing && !state.stopped;
      const ch = message.guild.channels.cache.get(state.voiceChannelId);
      await message.reply({ embeds: [new EmbedBuilder()
        .setColor(live ? Colors.Green : Colors.Red)
        .setTitle("📻 Radio Status")
        .addFields(
          { name: "Station",  value: state.stationName,                   inline: true },
          { name: "Status",   value: live ? "🟢 Live" : "🔴 Stopped",     inline: true },
          { name: "Channel",  value: ch ? `<#${ch.id}>` : "Unknown",      inline: true },
          { name: "Engine",   value: "✅ @discordjs/voice (100% free)",    inline: true },
        )
        .setFooter({ text: "Powered by @discordjs/voice — no external server needed" })] });
      return;
    }

    // ── !radiostation <key> ───────────────────────────────────────────────────
    if (content.startsWith("!radiostation ")) {
      if (!isAdmin()) { await message.reply("❌ Administrator only."); return; }
      const key = content.slice("!radiostation ".length).trim();
      const station = BUILTIN_STATIONS[key];
      if (!station) {
        await message.reply(`❌ Unknown station \`${key}\`. Use \`!stations\` to see all options.`);
        return;
      }
      const state = radioStates.get(guildId);
      if (!state) { await message.reply("❌ No radio configured. Use `!setradio <channel>` first."); return; }
      state.streamUrl = station.url;
      state.stationName = station.name;
      state.stopped = false;
      await saveRadioConfig(state);
      await stopRadio(guildId);
      state.stopped = false;
      await message.reply(`🎵 Switching to **${station.name}**...`);
      setTimeout(() => startRadio(client, guildId), 1_000);
      return;
    }

    // ── !stations ─────────────────────────────────────────────────────────────
    if (content === "!stations") {
      const categories: Record<string, string> = { music: "🎵 Music", news: "📰 World News", japan: "🇯🇵 Japanese" };
      const grouped: Record<string, string[]> = { music: [], news: [], japan: [] };
      for (const [k, v] of Object.entries(BUILTIN_STATIONS)) {
        grouped[v.category]?.push(`\`!radiostation ${k}\` — **${v.name}**`);
      }
      const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle("📻 Built-in Radio Stations");
      for (const [cat, label] of Object.entries(categories)) {
        if (grouped[cat]?.length) embed.addFields({ name: label, value: grouped[cat].join("\n") });
      }
      embed.setFooter({ text: "Or use !radiosearch <keyword> to find any real FM station from 30,000+ worldwide" });
      await message.reply({ embeds: [embed] });
      return;
    }

    // ── !radiosearch <query> ──────────────────────────────────────────────────
    if (content.startsWith("!radiosearch ") || content.startsWith("!rsearch ")) {
      const query = content.startsWith("!rsearch ")
        ? content.slice("!rsearch ".length).trim()
        : content.slice("!radiosearch ".length).trim();

      if (!query) { await message.reply("❌ Usage: `!radiosearch <name or country>`"); return; }

      const state = radioStates.get(guildId);
      if (!state) { await message.reply("❌ No radio configured yet. Use `!setradio <voice channel>` first."); return; }

      const searching = await message.reply(`🔍 Searching for **"${query}"**...`);
      const stations = await searchRadioBrowser(query, 8);
      if (stations.length === 0) {
        await searching.edit(`❌ No stations found for **"${query}"**.`);
        return;
      }

      pendingSearches.set(guildId, { stations, expiresAt: Date.now() + 60_000 });
      const lines = stations.map((s, i) => {
        const country  = s.country  ? ` 🌍 ${s.country}` : "";
        const bitrate  = s.bitrate  ? ` · ${s.bitrate}kbps` : "";
        const language = s.language ? ` · ${s.language}` : "";
        return `**${i + 1}.** ${s.name}${country}${bitrate}${language}`;
      });
      const embed = new EmbedBuilder()
        .setColor(0xbc002d)
        .setTitle(`📻 Search Results: "${query}"`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Type a number (1-8) within 60 seconds to play that station" });
      await searching.edit({ content: "", embeds: [embed] });
      return;
    }

    // ── Number pick — select from !radiosearch results ────────────────────────
    {
      const pick = /^[1-8]$/.test(content.trim()) ? parseInt(content.trim(), 10) : null;
      if (pick !== null) {
        const pending = pendingSearches.get(guildId);
        if (pending && Date.now() < pending.expiresAt) {
          const station = pending.stations[pick - 1];
          if (station) {
            pendingSearches.delete(guildId);
            const state = radioStates.get(guildId);
            if (!state) { await message.reply("❌ No radio configured."); return; }
            state.streamUrl = station.url_resolved;
            state.stationName = station.name;
            state.stopped = false;
            await saveRadioConfig(state);
            reportRBClick(station.stationuuid);
            await stopRadio(guildId);
            state.stopped = false;
            const countryLine = station.country ? ` · 🌍 ${station.country}` : "";
            const msg = await message.reply(`📻 Switching to **${station.name}**${countryLine}...`);
            setTimeout(async () => {
              await startRadio(client, guildId);
              await msg.edit(`✅ Now playing **${station.name}** 🎵`).catch(() => {});
            }, 1_000);
          }
        }
      }
    }
  });
}
