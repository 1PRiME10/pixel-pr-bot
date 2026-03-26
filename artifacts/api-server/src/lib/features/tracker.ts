// ─── Anime & Manga Release Tracker ────────────────────────────────────────────
// Tracks anime episode countdowns (AniList) and manga chapter releases (MangaDex).
// No API keys required — both APIs are public.
//
// Commands:
//   !trackchannel #ch     — set the notification channel (admin)
//   !track anime <name>   — subscribe to anime episode alerts
//   !track manga <name>   — subscribe to manga chapter alerts
//   !untrack <name>       — remove a title
//   !tracklist            — list all tracked titles
//   !countdown <name>     — show time until next episode (any user)

import { Client, Message, TextChannel, PermissionFlagsBits, EmbedBuilder } from "discord.js";
import { pool } from "@workspace/db";

// ─── Types ────────────────────────────────────────────────────────────────────
interface AniListMedia {
  id: number;
  title: { romaji: string; english: string | null };
  status: string;
  coverImage: { medium: string };
  nextAiringEpisode: { episode: number; timeUntilAiring: number; airingAt: number } | null;
  episodes: number | null;
}

interface MangaDexChapter {
  id: string;
  attributes: { chapter: string | null; publishAt: string; title: string | null };
}

// ─── DB init ──────────────────────────────────────────────────────────────────
export async function initTracker(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracker_channels (
      guild_id   TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_titles (
      id               SERIAL PRIMARY KEY,
      guild_id         TEXT    NOT NULL,
      type             TEXT    NOT NULL CHECK (type IN ('anime','manga')),
      name             TEXT    NOT NULL,
      api_id           TEXT    NOT NULL,
      cover_url        TEXT,
      last_notified    TEXT,
      added_by         TEXT    NOT NULL,
      UNIQUE (guild_id, api_id, type)
    )
  `);
}

// ─── AniList query helper ─────────────────────────────────────────────────────
async function anilistSearch(query: string): Promise<AniListMedia | null> {
  const gql = `
    query ($search: String) {
      Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id title { romaji english } status episodes
        coverImage { medium }
        nextAiringEpisode { episode timeUntilAiring airingAt }
      }
    }`;
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { search: query } }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json() as any;
    return json?.data?.Media ?? null;
  } catch {
    return null;
  }
}

async function anilistById(id: number): Promise<AniListMedia | null> {
  const gql = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id title { romaji english } status episodes
        coverImage { medium }
        nextAiringEpisode { episode timeUntilAiring airingAt }
      }
    }`;
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { id } }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = await res.json() as any;
    return json?.data?.Media ?? null;
  } catch {
    return null;
  }
}

// ─── MangaDex helpers ─────────────────────────────────────────────────────────
async function mangadexSearch(title: string): Promise<{ id: string; name: string; cover: string } | null> {
  try {
    const res = await fetch(
      `https://api.mangadex.org/manga?title=${encodeURIComponent(title)}&limit=1&order[relevance]=desc`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const json = await res.json() as any;
    const manga = json?.data?.[0];
    if (!manga) return null;
    const name =
      manga.attributes.title["en"] ??
      Object.values(manga.attributes.title)[0] ??
      title;
    // Get cover art
    const coverId = manga.relationships?.find((r: any) => r.type === "cover_art")?.id;
    let cover = "";
    if (coverId) {
      const cRes = await fetch(`https://api.mangadex.org/cover/${coverId}`, { signal: AbortSignal.timeout(5_000) });
      const cJson = await cRes.json() as any;
      const fn = cJson?.data?.attributes?.fileName;
      if (fn) cover = `https://uploads.mangadex.org/covers/${manga.id}/${fn}.256.jpg`;
    }
    return { id: manga.id, name: String(name), cover };
  } catch {
    return null;
  }
}

async function mangadexLatestChapter(mangaId: string): Promise<MangaDexChapter | null> {
  try {
    const res = await fetch(
      `https://api.mangadex.org/chapter?manga=${mangaId}&translatedLanguage[]=en&order[publishAt]=desc&limit=1`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const json = await res.json() as any;
    return json?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Countdown formatter ──────────────────────────────────────────────────────
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Airing now!";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`**${d}d**`);
  if (h > 0) parts.push(`**${h}h**`);
  if (m > 0) parts.push(`**${m}m**`);
  if (d === 0) parts.push(`**${s}s**`); // show seconds only when < 1 day
  return parts.join(" ");
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
let trackerRunning  = false; // prevent concurrent poll cycles
let pollRegistered  = false; // ensure intervals are only created once (even across reconnects)
let activeClient: Client | null = null; // always points to the latest connected client

async function getChannel(chId: string): Promise<TextChannel | null> {
  if (!activeClient) return null;
  let ch = activeClient.channels.cache.get(chId) as TextChannel | undefined;
  if (!ch) {
    try { ch = await activeClient.channels.fetch(chId) as TextChannel; } catch { return null; }
  }
  return ch ?? null;
}

async function pollTrackedTitles(): Promise<void> {
  if (trackerRunning) return;
  trackerRunning = true;

  try {
    const { rows: channels } = await pool.query<{ guild_id: string; channel_id: string }>(
      `SELECT * FROM tracker_channels`,
    );
    if (channels.length === 0) {
      console.log("[Tracker] Poll cycle: no channels configured, skipping.");
      return;
    }

    const channelMap = new Map(channels.map(r => [r.guild_id, r.channel_id]));
    const { rows: titles } = await pool.query(`SELECT * FROM tracked_titles`);

    for (const row of titles) {
      try {
        const chId = channelMap.get(row.guild_id);
        if (!chId) continue;
        const ch = await getChannel(chId);
        if (!ch) continue;

        if (row.type === "anime") {
          const media = await anilistById(Number(row.api_id));
          if (!media?.nextAiringEpisode) continue;

          const { episode, airingAt } = media.nextAiringEpisode;
          const airingKey = `ep${episode}`;

          const nowSec = Math.floor(Date.now() / 1000);
          if (airingAt > nowSec) continue; // hasn't aired yet

          // Atomic claim: only proceeds if last_notified was NOT already this key.
          // This prevents two concurrent bot instances from both sending the same notification.
          const claimed = await pool.query(
            `UPDATE tracked_titles SET last_notified = $1
             WHERE id = $2 AND (last_notified IS DISTINCT FROM $1)
             RETURNING id`,
            [airingKey, row.id],
          );
          if ((claimed.rowCount ?? 0) === 0) continue; // another instance already sent it

          const title = media.title.english ?? media.title.romaji;
          const embed = new EmbedBuilder()
            .setColor(0x02a9ff)
            .setTitle(`🎬 New Episode Out! — ${title}`)
            .setDescription(`**Episode ${episode}** is now airing in Japan! 🇯🇵\n<https://anilist.co/anime/${media.id}>`)
            .setThumbnail(media.coverImage.medium)
            .setFooter({ text: "Tracker • AniList" })
            .setTimestamp();

          await ch.send({ content: `@everyone`, embeds: [embed] }).catch(() => {});
          console.log(`[Tracker] Sent anime notification: ${title} ep${episode}`);
        } else if (row.type === "manga") {
          const chapter = await mangadexLatestChapter(row.api_id);
          if (!chapter) continue;

          const chNum = chapter.attributes.chapter ?? "?";
          const chapterKey = `ch${chNum}`;

          // Atomic claim: prevents two instances from both sending the same chapter alert
          const claimed = await pool.query(
            `UPDATE tracked_titles SET last_notified = $1
             WHERE id = $2 AND (last_notified IS DISTINCT FROM $1)
             RETURNING id`,
            [chapterKey, row.id],
          );
          if ((claimed.rowCount ?? 0) === 0) continue;

          const embed = new EmbedBuilder()
            .setColor(0xff6740)
            .setTitle(`📖 New Chapter! — ${row.name}`)
            .setDescription(
              `**Chapter ${chNum}**${chapter.attributes.title ? ` — *${chapter.attributes.title}*` : ""} is now available on MangaDex!`,
            )
            .setThumbnail(row.cover_url ?? "")
            .setURL(`https://mangadex.org/title/${row.api_id}`)
            .setFooter({ text: "Tracker • MangaDex" })
            .setTimestamp();

          await ch.send({ content: `@everyone`, embeds: [embed] }).catch(() => {});
          console.log(`[Tracker] Sent manga notification: ${row.name} ch${chNum}`);
        }
      } catch (titleErr) {
        console.error(`[Tracker] Error checking "${row.name}" (${row.type}):`, titleErr);
      }
    }
  } catch (err) {
    console.error("[Tracker] Poll cycle error:", err);
  } finally {
    trackerRunning = false;
  }
}

// ─── Slash-command helpers ─────────────────────────────────────────────────────
export async function searchAndTrackTitle(
  guildId: string, type: "anime" | "manga", name: string, addedBy: string,
): Promise<EmbedBuilder | string> {
  if (type === "anime") {
    const media = await anilistSearch(name);
    if (!media) return `❌ Couldn't find an anime called **${name}** on AniList.`;
    const { rowCount } = await pool.query(
      `INSERT INTO tracked_titles (guild_id, type, name, api_id, cover_url, last_notified, added_by)
       VALUES ($1,'anime',$2,$3,$4,$5,$6) ON CONFLICT (guild_id, api_id, type) DO NOTHING`,
      [guildId, media.title.english ?? media.title.romaji, String(media.id),
       media.coverImage.medium,
       media.nextAiringEpisode ? `ep${media.nextAiringEpisode.episode - 1}` : null, addedBy],
    );
    const title = media.title.english ?? media.title.romaji;
    if (!rowCount || rowCount === 0) return `⚠️ **${title}** is already in the tracking list.`;
    const next = media.nextAiringEpisode;
    return new EmbedBuilder()
      .setColor(0x02a9ff).setTitle(`✅ Now tracking — ${title}`).setThumbnail(media.coverImage.medium)
      .addFields(
        { name: "Status", value: media.status.replace(/_/g, " "), inline: true },
        { name: "Episodes", value: String(media.episodes ?? "?"), inline: true },
        { name: "Next Episode", value: next ? `Ep ${next.episode} — ${formatCountdown(next.timeUntilAiring)}` : "No upcoming episode", inline: false },
      ).setFooter({ text: "AniList • updates every 5 min" });
  } else {
    const result = await mangadexSearch(name);
    if (!result) return `❌ Couldn't find a manga called **${name}** on MangaDex.`;
    const latest = await mangadexLatestChapter(result.id);
    const { rowCount } = await pool.query(
      `INSERT INTO tracked_titles (guild_id, type, name, api_id, cover_url, last_notified, added_by)
       VALUES ($1,'manga',$2,$3,$4,$5,$6) ON CONFLICT (guild_id, api_id, type) DO NOTHING`,
      [guildId, result.name, result.id, result.cover,
       latest ? `ch${latest.attributes.chapter ?? "?"}` : null, addedBy],
    );
    if (!rowCount || rowCount === 0) return `⚠️ **${result.name}** is already in the tracking list.`;
    return new EmbedBuilder()
      .setColor(0xff6740).setTitle(`✅ Now tracking — ${result.name}`)
      .setThumbnail(result.cover).setURL(`https://mangadex.org/title/${result.id}`)
      .addFields({ name: "Latest Chapter", value: latest ? `Chapter ${latest.attributes.chapter ?? "?"} (${new Date(latest.attributes.publishAt).toLocaleDateString("en-GB")})` : "None found" })
      .setFooter({ text: "MangaDex • updates every 5 min" });
  }
}

export async function anilistCountdown(name: string): Promise<string> {
  const media = await anilistSearch(name);
  if (!media) return `❌ Couldn't find **${name}** on AniList.`;
  const title = media.title.english ?? media.title.romaji;
  const next  = media.nextAiringEpisode;
  if (!next)  return `⏳ **${title}** has no scheduled upcoming episode.`;
  return `⏳ **${title}** — Episode **${next.episode}** airs in **${formatCountdown(next.timeUntilAiring)}**.`;
}

// ─── Register (poll only — commands are routed from the main handler) ─────────
// Registering a separate messageCreate listener for commands caused split-brain
// deduplication (in-memory Set vs DB-backed) which led to double responses when
// more than one bot instance was running. Commands are now handled via
// handleTrackerMessage(), called directly from the main handler which already
// uses DB-backed dedup (tryClaimMessage).
export function registerTracker(client: Client, _PREFIX: string): void {
  // Always keep activeClient current so the poll can send to the right instance
  activeClient = client;

  // Set up poll timers ONCE — singleton guard survives reconnects
  if (!pollRegistered) {
    pollRegistered = true;
    setTimeout(() => pollTrackedTitles().catch(console.error), 60_000);
    setInterval(() => pollTrackedTitles().catch(console.error), 5 * 60_000);
  }
}

// ─── Command handler (called from discord-bot.ts main message handler) ────────
// Returns true if the command was handled (so the caller can early-return).
export async function handleTrackerMessage(
  message: Message,
  command: string,
  args: string[],
  PREFIX: string,
): Promise<boolean> {
  if (!message.guild) return false;

  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

  try {
    // ── !trackchannel #channel ──────────────────────────────────────────────
    if (command === "trackchannel") {
      if (!isAdmin) { await message.reply("⛔ Admins only."); return true; }

      const mentioned = message.mentions.channels.first();
      if (!mentioned || mentioned.type !== 0 /* GuildText */) {
        const { rows } = await pool.query(
          `SELECT channel_id FROM tracker_channels WHERE guild_id = $1`,
          [message.guild.id],
        );
        const current = rows[0]?.channel_id;
        await message.reply(
          `**Usage:** \`${PREFIX}trackchannel #channel\`\n` +
          (current ? `📌 Current channel: <#${current}>` : `📌 No channel set yet.`),
        );
        return true;
      }

      await pool.query(
        `INSERT INTO tracker_channels (guild_id, channel_id)
         VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
        [message.guild.id, mentioned.id],
      );
      await message.reply(`✅ Release notifications will be sent to <#${mentioned.id}>.`);
      return true;
    }

    // ── !track (alone — show help) ──────────────────────────────────────────
    if (command === "track" && args.length === 0) {
      await message.reply(
        `**Tracker commands:**\n` +
        `\`${PREFIX}track anime <name>\` — notify when a new episode airs 🎬\n` +
        `\`${PREFIX}track manga <name>\` — notify when a new chapter drops 📖\n` +
        `\`${PREFIX}tracklist\` — show all tracked titles\n` +
        `\`${PREFIX}untrack <name>\` — stop tracking a title\n` +
        `\`${PREFIX}trackchannel #channel\` — set notification channel (admin only)`,
      );
      return true;
    }

    // ── !track anime/manga <name> ───────────────────────────────────────────
    if (command === "track" && args.length >= 1) {
      const type = args[0].toLowerCase();
      const name = args.slice(1).join(" ").trim();

      if ((type !== "anime" && type !== "manga") || !name) {
        await message.reply(
          `**Usage:**\n` +
          `\`${PREFIX}track anime <name>\` — get notified when a new episode airs\n` +
          `\`${PREFIX}track manga <name>\` — get notified when a new chapter drops`,
        );
        return true;
      }

      // Check notification channel is set
      const { rows: chRows } = await pool.query(
        `SELECT channel_id FROM tracker_channels WHERE guild_id = $1`,
        [message.guild.id],
      );
      if (!chRows[0]) {
        await message.reply(`⚠️ Set a notification channel first with \`${PREFIX}trackchannel #channel\`.`);
        return true;
      }

      await (message.channel as TextChannel).sendTyping().catch(() => {});

      if (type === "anime") {
        const media = await anilistSearch(name);
        if (!media) { await message.reply(`❌ Couldn't find an anime called **${name}** on AniList.`); return true; }

        const { rowCount } = await pool.query(
          `INSERT INTO tracked_titles (guild_id, type, name, api_id, cover_url, last_notified, added_by)
           VALUES ($1, 'anime', $2, $3, $4, $5, $6)
           ON CONFLICT (guild_id, api_id, type) DO NOTHING`,
          [
            message.guild.id,
            media.title.english ?? media.title.romaji,
            String(media.id),
            media.coverImage.medium,
            media.nextAiringEpisode ? `ep${media.nextAiringEpisode.episode - 1}` : null,
            message.author.id,
          ],
        );

        const title = media.title.english ?? media.title.romaji;

        if (!rowCount || rowCount === 0) {
          await message.reply(`⚠️ **${title}** is already in the tracking list.`);
          return true;
        }

        const next = media.nextAiringEpisode;
        const embed = new EmbedBuilder()
          .setColor(0x02a9ff)
          .setTitle(`✅ Now tracking — ${title}`)
          .setThumbnail(media.coverImage.medium)
          .addFields(
            { name: "Status", value: media.status.replace(/_/g, " "), inline: true },
            { name: "Episodes", value: String(media.episodes ?? "?"), inline: true },
            {
              name: "Next Episode",
              value: next
                ? `Ep ${next.episode} — ${formatCountdown(next.timeUntilAiring)}`
                : "No upcoming episode",
              inline: false,
            },
          )
          .setFooter({ text: "AniList • updates every 5 minutes" });

        await message.reply({ embeds: [embed] });
        return true;
      }

      if (type === "manga") {
        const result = await mangadexSearch(name);
        if (!result) { await message.reply(`❌ Couldn't find a manga called **${name}** on MangaDex.`); return true; }

        const latest = await mangadexLatestChapter(result.id);
        const latestKey = latest ? `ch${latest.attributes.chapter ?? "?"}` : null;

        const { rowCount } = await pool.query(
          `INSERT INTO tracked_titles (guild_id, type, name, api_id, cover_url, last_notified, added_by)
           VALUES ($1, 'manga', $2, $3, $4, $5, $6)
           ON CONFLICT (guild_id, api_id, type) DO NOTHING`,
          [message.guild.id, result.name, result.id, result.cover, latestKey, message.author.id],
        );

        if (!rowCount || rowCount === 0) {
          await message.reply(`⚠️ **${result.name}** is already in the tracking list.`);
          return true;
        }

        const embed = new EmbedBuilder()
          .setColor(0xff6740)
          .setTitle(`✅ Now tracking — ${result.name}`)
          .setThumbnail(result.cover)
          .setURL(`https://mangadex.org/title/${result.id}`)
          .addFields({
            name: "Latest Chapter",
            value: latest
              ? `Chapter ${latest.attributes.chapter ?? "?"} (${new Date(latest.attributes.publishAt).toLocaleDateString("en-GB")})`
              : "None found",
          })
          .setFooter({ text: "MangaDex • updates every 5 minutes" });

        await message.reply({ embeds: [embed] });
        return true;
      }
    }

    // ── !untrack <name> ─────────────────────────────────────────────────────
    if (command === "untrack") {
      const name = args.join(" ").trim();
      if (!name) { await message.reply(`**Usage:** \`${PREFIX}untrack <name>\``); return true; }

      let res = await pool.query(
        `DELETE FROM tracked_titles WHERE guild_id = $1 AND LOWER(name) = LOWER($2) RETURNING name`,
        [message.guild.id, name],
      );

      if (!res.rowCount || res.rowCount === 0) {
        const matches = await pool.query(
          `SELECT id, name FROM tracked_titles WHERE guild_id = $1 AND LOWER(name) LIKE LOWER($2)`,
          [message.guild.id, `%${name}%`],
        );
        if ((matches.rowCount ?? 0) === 0) {
          await message.reply(`❌ No tracked title found matching **${name}**.`);
          return true;
        }
        if ((matches.rowCount ?? 0) > 1) {
          const list = matches.rows.map((r: any) => `• **${r.name}**`).join("\n");
          await message.reply(`⚠️ Multiple titles match "**${name}**" — be more specific:\n${list}`);
          return true;
        }
        res = await pool.query(
          `DELETE FROM tracked_titles WHERE id = $1 RETURNING name`,
          [matches.rows[0].id],
        );
      }

      await message.reply(`🗑️ Removed **${res.rows[0]?.name ?? name}** from the tracker.`);
      return true;
    }

    // ── !tracklist ──────────────────────────────────────────────────────────
    if (command === "tracklist") {
      const { rows } = await pool.query(
        `SELECT type, name, last_notified FROM tracked_titles WHERE guild_id = $1 ORDER BY type, name`,
        [message.guild.id],
      );
      if (rows.length === 0) {
        await message.reply(`📭 No titles tracked yet. Use \`${PREFIX}track anime/manga <name>\` to add one.`);
        return true;
      }

      const animeLines = rows.filter((r: any) => r.type === "anime").map((r: any) => `🎬 **${r.name}**`);
      const mangaLines = rows.filter((r: any) => r.type === "manga").map((r: any) => `📖 **${r.name}**`);

      const sections: string[] = [];
      if (animeLines.length) sections.push(`__Anime__\n${animeLines.join("\n")}`);
      if (mangaLines.length) sections.push(`__Manga__\n${mangaLines.join("\n")}`);

      const fullDesc = sections.join("\n\n");
      const chunks: string[] = [];
      if (fullDesc.length <= 4096) {
        chunks.push(fullDesc);
      } else {
        const allLines = fullDesc.split("\n");
        let current = "";
        for (const line of allLines) {
          if ((current + "\n" + line).length > 4000) {
            chunks.push(current.trim());
            current = line;
          } else {
            current = current ? current + "\n" + line : line;
          }
        }
        if (current.trim()) chunks.push(current.trim());
      }

      for (let i = 0; i < chunks.length; i++) {
        const embed = new EmbedBuilder()
          .setColor(0x7289da)
          .setTitle(i === 0 ? "📋 Tracked Titles" : "📋 Tracked Titles (cont.)")
          .setDescription(chunks[i]);
        if (i === chunks.length - 1) {
          embed.setFooter({ text: `${rows.length} title(s) — notifications every 5 min` });
        }
        if (i === 0) await message.reply({ embeds: [embed] });
        else await (message.channel as any).send({ embeds: [embed] });
      }
      return true;
    }

    // ── !countdown <anime name> ─────────────────────────────────────────────
    if (command === "countdown") {
      const name = args.join(" ").trim();
      if (!name) { await message.reply(`**Usage:** \`${PREFIX}countdown <anime name>\``); return true; }

      await (message.channel as TextChannel).sendTyping().catch(() => {});
      const media = await anilistSearch(name);
      if (!media) { await message.reply(`❌ Couldn't find **${name}** on AniList.`); return true; }

      const title = media.title.english ?? media.title.romaji;
      const next  = media.nextAiringEpisode;

      if (!next) {
        await message.reply(
          `**${title}** — ${media.status === "FINISHED" ? "✅ Finished airing." : "No upcoming episode scheduled."}`,
        );
        return true;
      }

      const embed = new EmbedBuilder()
        .setColor(0x02a9ff)
        .setTitle(`⏱️ ${title}`)
        .setThumbnail(media.coverImage.medium)
        .addFields(
          { name: "Next Episode", value: `Episode **${next.episode}**`, inline: true },
          { name: "Time Remaining", value: formatCountdown(next.timeUntilAiring), inline: true },
          { name: "Airs At", value: `<t:${next.airingAt}:F>`, inline: false },
        )
        .setFooter({ text: "AniList" });

      await message.reply({ embeds: [embed] });
      return true;
    }
  } catch (err) {
    console.error(`[Tracker] Error handling command "${command}":`, err);
    await message.reply("❌ Something went wrong with the tracker. Please try again.").catch(() => {});
    return true;
  }

  return false;
}
