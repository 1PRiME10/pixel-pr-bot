// ─── YouTube Channel Monitor ──────────────────────────────────────────────────
// Monitors YouTube channels for new videos using YouTube's public RSS feed.
// No API key required. Polls every 10 minutes.
//
// Supported input formats:
//   • @handle          (e.g. @MrBeast)
//   • Channel URL      (e.g. https://youtube.com/@MrBeast)
//   • Channel ID       (e.g. UCxxxxxxxxxxxxxxxx)
//   • Full channel URL (e.g. https://youtube.com/channel/UCxxxxxxxxxxxxxxxx)

import {
  Client,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from "discord.js";
import Parser from "rss-parser";
import { pool } from "@workspace/db";

const POLL_INTERVAL_MS  = 10 * 60 * 1000; // 10 minutes
const FAILURE_THRESHOLD = 5;
const DEAD_THRESHOLD    = 20;
const LOCK_KEY          = 112233445;        // unique advisory lock key

// ─── RSS item shape ───────────────────────────────────────────────────────────
interface YTVideo {
  videoId:     string;
  title:       string;
  url:         string;
  channelName: string;
  channelId:   string;
  pubDate:     string;
  description: string;
  thumbnailUrl: string;
}

const rssParser = new Parser({
  timeout: 8_000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; PixelBot/1.0)" },
  customFields: {
    item: [
      ["media:group", "mediaGroup"],
      ["yt:videoId", "ytVideoId"],
      ["yt:channelId", "ytChannelId"],
    ],
  },
});

// ─── DB setup ─────────────────────────────────────────────────────────────────
export async function initYouTubeMonitor(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS youtube_monitors (
      id              SERIAL PRIMARY KEY,
      guild_id        TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      yt_channel_id   TEXT NOT NULL,
      yt_channel_name TEXT NOT NULL DEFAULT '',
      last_video_id   TEXT,
      fail_count      INTEGER NOT NULL DEFAULT 0,
      last_fail_at    TIMESTAMPTZ,
      unreachable     BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(guild_id, yt_channel_id)
    )
  `);
}

// ─── Resolve input → YouTube channel ID ──────────────────────────────────────
// Accepts: @handle, channel URL, channel ID
export async function resolveYTChannelId(input: string): Promise<{ channelId: string; channelName: string } | null> {
  input = input.trim();

  // Already a raw channel ID (UCxxxx...)
  if (/^UC[\w-]{20,}$/.test(input)) {
    const name = await fetchChannelNameById(input);
    return name ? { channelId: input, channelName: name } : null;
  }

  // Extract channel ID from URL: /channel/UCxxx
  const channelUrlMatch = input.match(/youtube\.com\/channel\/(UC[\w-]{20,})/);
  if (channelUrlMatch) {
    const channelId = channelUrlMatch[1];
    const name = await fetchChannelNameById(channelId);
    return name ? { channelId, channelName: name } : { channelId, channelName: channelId };
  }

  // Handle or @handle or youtube.com/@handle
  const handleMatch = input.match(/@([\w.-]+)/) ?? input.match(/youtube\.com\/([\w.-]+)$/);
  const handle = handleMatch ? handleMatch[1] : input.replace(/^@/, "").trim();
  if (!handle) return null;

  return fetchChannelByHandle(handle);
}

// Fetch the channel ID and name from a @handle using YouTube's public page
async function fetchChannelByHandle(handle: string): Promise<{ channelId: string; channelName: string } | null> {
  const urls = [
    `https://www.youtube.com/@${handle}`,
    `https://www.youtube.com/c/${handle}`,
    `https://www.youtube.com/user/${handle}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Extract channelId from page meta/JS
      const idMatch =
        html.match(/"channelId"\s*:\s*"(UC[\w-]{20,})"/) ??
        html.match(/channel_id=\s*(UC[\w-]{20,})/)       ??
        html.match(/"externalId"\s*:\s*"(UC[\w-]{20,})"/);
      if (!idMatch) continue;

      const channelId = idMatch[1];

      // Extract channel name
      const nameMatch =
        html.match(/"title"\s*:\s*"([^"]{1,80})"/) ??
        html.match(/<title>([^<]+)<\/title>/);
      const channelName = nameMatch
        ? nameMatch[1].replace(/ - YouTube$/, "").trim()
        : handle;

      return { channelId, channelName };
    } catch { continue; }
  }
  return null;
}

// Confirm a channel ID is valid by fetching the RSS feed title
async function fetchChannelNameById(channelId: string): Promise<string | null> {
  try {
    const feed = await rssParser.parseURL(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    );
    return feed.title ?? null;
  } catch { return null; }
}

// ─── Fetch latest videos from RSS ────────────────────────────────────────────
export async function fetchLatestVideos(channelId: string): Promise<YTVideo[]> {
  const url  = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const feed = await rssParser.parseURL(url);

  return (feed.items ?? []).slice(0, 5).map((item: any) => {
    const videoId = item.ytVideoId
      ?? item.id?.replace("yt:video:", "")
      ?? item.link?.match(/v=([\w-]+)/)?.[1]
      ?? "";

    const thumbnail =
      item.mediaGroup?.["media:thumbnail"]?.[0]?.["$"]?.url
      ?? (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : "");

    const description =
      item.mediaGroup?.["media:description"]?.[0]
      ?? item.contentSnippet
      ?? "";

    return {
      videoId,
      title:       item.title ?? "Untitled",
      url:         item.link  ?? `https://www.youtube.com/watch?v=${videoId}`,
      channelName: feed.title ?? "Unknown Channel",
      channelId:   item.ytChannelId ?? channelId,
      pubDate:     item.pubDate ?? item.isoDate ?? "",
      description: (description as string).slice(0, 300),
      thumbnailUrl: thumbnail,
    };
  });
}

// ─── Build Discord embed ──────────────────────────────────────────────────────
function buildVideoEmbed(video: YTVideo): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setAuthor({
      name:    video.channelName,
      iconURL: `https://www.youtube.com/s/desktop/d7c3e9c9/img/favicon_144x144.png`,
      url:     `https://www.youtube.com/channel/${video.channelId}`,
    })
    .setTitle(video.title)
    .setURL(video.url)
    .setImage(video.thumbnailUrl || null)
    .setTimestamp(video.pubDate ? new Date(video.pubDate) : new Date())
    .setFooter({ text: "YouTube", iconURL: "https://www.youtube.com/s/desktop/d7c3e9c9/img/favicon_144x144.png" });

  if (video.description) {
    embed.setDescription(
      video.description.length > 300
        ? video.description.slice(0, 297) + "..."
        : video.description
    );
  }

  return embed;
}

function buildVideoButton(videoUrl: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Watch on YouTube")
      .setStyle(ButtonStyle.Link)
      .setURL(videoUrl)
      .setEmoji("▶️")
  );
}

// ─── Poll one channel ─────────────────────────────────────────────────────────
async function pollChannel(
  client:       Client,
  guildId:      string,
  discordChId:  string,
  ytChannelId:  string,
  ytChannelName: string,
  lastVideoId:  string | null,
  failCount:    number,
  lastFailAt:   Date | null,
  unreachable:  boolean,
): Promise<{ newId: string | null; failCount: number; unreachable: boolean }> {
  if (unreachable) return { newId: lastVideoId, failCount, unreachable: true };

  // Slow-retry mode: only check once per hour when failing
  if (failCount >= FAILURE_THRESHOLD && lastFailAt) {
    if (Date.now() - lastFailAt.getTime() < 60 * 60 * 1000) {
      return { newId: lastVideoId, failCount, unreachable: false };
    }
  }

  let videos: YTVideo[];
  try {
    videos = await fetchLatestVideos(ytChannelId);
    console.log(`[YouTube] "${ytChannelName}" ✓ (${videos.length} videos)`);
  } catch (err) {
    const newFail = failCount + 1;
    const nowDead = newFail >= DEAD_THRESHOLD;

    await pool.query(
      `UPDATE youtube_monitors SET fail_count=$1, last_fail_at=NOW(), unreachable=$2
       WHERE guild_id=$3 AND yt_channel_id=$4`,
      [newFail, nowDead, guildId, ytChannelId],
    );

    if (nowDead) {
      const ch = client.channels.cache.get(discordChId) as TextChannel | undefined;
      await ch?.send(
        `⚠️ **YouTube Monitor**: Could not reach **${ytChannelName}** after ${newFail} attempts.\n` +
        `Use \`/removeyoutube\` to stop monitoring, or check if the channel is still active.`
      ).catch(() => {});
    }
    return { newId: lastVideoId, failCount: newFail, unreachable: nowDead };
  }

  // Reset fail count on success
  if (failCount > 0) {
    await pool.query(
      `UPDATE youtube_monitors SET fail_count=0, last_fail_at=NULL, unreachable=FALSE
       WHERE guild_id=$1 AND yt_channel_id=$2`,
      [guildId, ytChannelId],
    );
  }

  if (!videos.length) return { newId: lastVideoId, failCount: 0, unreachable: false };

  // Determine new videos
  const newVideos = lastVideoId
    ? videos.filter(v => v.videoId !== lastVideoId &&
        (videos.findIndex(x => x.videoId === lastVideoId) === -1 ||
          videos.indexOf(v) < videos.findIndex(x => x.videoId === lastVideoId)
        )
      ).reverse()
    : [videos[0]];

  if (!newVideos.length) return { newId: lastVideoId, failCount: 0, unreachable: false };

  const ch = client.channels.cache.get(discordChId) as TextChannel | undefined;
  if (!ch) return { newId: lastVideoId, failCount: 0, unreachable: false };

  for (const video of newVideos) {
    try {
      await ch.send({
        content: `🎬 **${video.channelName}** just uploaded a new video!`,
        embeds:  [buildVideoEmbed(video)],
        components: [buildVideoButton(video.url)],
      });
    } catch { /* no perms or deleted */ }
  }

  const latestId = newVideos[newVideos.length - 1].videoId;
  return { newId: latestId, failCount: 0, unreachable: false };
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
let pollRunning = false;

async function runPollCycle(client: Client): Promise<void> {
  if (pollRunning) {
    console.log("[YouTube] Poll already running — skipping tick");
    return;
  }
  pollRunning = true;

  const lockClient = await pool.connect();
  let gotLock = false;
  try {
    const res = await lockClient.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`);
    gotLock = res.rows[0]?.locked === true;
  } catch {
    lockClient.release();
    pollRunning = false;
    return;
  }

  if (!gotLock) {
    console.log("[YouTube] Another instance is polling — skipping");
    lockClient.release();
    pollRunning = false;
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT guild_id, channel_id, yt_channel_id, yt_channel_name,
              last_video_id, fail_count, last_fail_at, unreachable
       FROM youtube_monitors`
    );

    for (const row of rows) {
      try {
        const result = await pollChannel(
          client,
          row.guild_id,
          row.channel_id,
          row.yt_channel_id,
          row.yt_channel_name,
          row.last_video_id,
          row.fail_count ?? 0,
          row.last_fail_at,
          row.unreachable ?? false,
        );
        if (result.newId && result.newId !== row.last_video_id) {
          await pool.query(
            `UPDATE youtube_monitors SET last_video_id=$1 WHERE guild_id=$2 AND yt_channel_id=$3`,
            [result.newId, row.guild_id, row.yt_channel_id],
          );
        }
      } catch (e) {
        console.error(`[YouTube] Error polling "${row.yt_channel_name}":`, e);
      }
    }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
    lockClient.release();
    pollRunning = false;
  }
}

// ─── Public CRUD functions (used by slash commands) ───────────────────────────
export async function addYouTubeChannel(opts: {
  guildId:      string;
  channelId:    string;   // Discord channel
  ytChannelId:  string;
  ytChannelName: string;
  lastVideoId:  string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO youtube_monitors
       (guild_id, channel_id, yt_channel_id, yt_channel_name, last_video_id, fail_count, unreachable)
     VALUES ($1,$2,$3,$4,$5,0,FALSE)
     ON CONFLICT (guild_id, yt_channel_id)
     DO UPDATE SET channel_id=$2, yt_channel_name=$4, last_video_id=$5,
                   fail_count=0, last_fail_at=NULL, unreachable=FALSE`,
    [opts.guildId, opts.channelId, opts.ytChannelId, opts.ytChannelName, opts.lastVideoId],
  );
}

export async function removeYouTubeChannel(guildId: string, ytChannelId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM youtube_monitors WHERE guild_id=$1 AND yt_channel_id=$2`,
    [guildId, ytChannelId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listYouTubeChannels(guildId: string): Promise<Array<{
  ytChannelId: string; ytChannelName: string; channelId: string;
  failCount: number; unreachable: boolean;
}>> {
  const { rows } = await pool.query(
    `SELECT yt_channel_id, yt_channel_name, channel_id, fail_count, unreachable
     FROM youtube_monitors WHERE guild_id=$1 ORDER BY yt_channel_name`,
    [guildId],
  );
  return rows.map(r => ({
    ytChannelId:   r.yt_channel_id,
    ytChannelName: r.yt_channel_name,
    channelId:     r.channel_id,
    failCount:     r.fail_count,
    unreachable:   r.unreachable,
  }));
}

// Get a channel entry by name (for remove-by-name support)
export async function findYTChannelByName(guildId: string, name: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT yt_channel_id FROM youtube_monitors
     WHERE guild_id=$1 AND LOWER(yt_channel_name) LIKE LOWER($2)
     LIMIT 1`,
    [guildId, `%${name}%`],
  );
  return rows[0]?.yt_channel_id ?? null;
}

// ─── Register ─────────────────────────────────────────────────────────────────
export async function registerYouTubeMonitor(client: Client): Promise<void> {
  await initYouTubeMonitor();
  setInterval(() => runPollCycle(client), POLL_INTERVAL_MS);
  setTimeout(() => runPollCycle(client), 20_000); // warm start after 20s
  console.log("[YouTube] ✅ YouTube monitor started (polling every 10 min)");
}
