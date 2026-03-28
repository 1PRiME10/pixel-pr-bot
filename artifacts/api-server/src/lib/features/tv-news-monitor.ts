// ─── TV & Entertainment News Monitor ─────────────────────────────────────────
// Monitors official Anime / International Film-TV / Korean Drama RSS feeds
// every 15 minutes and posts new releases, season announcements & entertainment
// news to a configured Discord channel.
//
// Sources (all verified public RSS, no API key required):
//   🎌 Anime  — MyAnimeList, Anime Corner, Otaku USA, Comic Natalie
//   🌍 Intl   — Deadline, Variety, Collider, Screen Rant
//   🇰🇷 Korean — Soompi, Dramabeans, Koreaboo

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

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LOCK_KEY         = 554433221;       // unique advisory lock key

// ─── TV News Sources ──────────────────────────────────────────────────────────
export interface TVSource {
  id:      string;
  name:    string;
  flag:    string;
  lang:    "anime" | "intl" | "kr";
  rssUrl:  string;
  color:   number;
}

export const TV_SOURCES: TVSource[] = [
  // ── Anime / Japanese ───────────────────────────────────────────────────────
  {
    id:     "myanimelist",
    name:   "MyAnimeList",
    flag:   "🎌",
    lang:   "anime",
    rssUrl: "https://myanimelist.net/rss/news.xml",
    color:  0x2E51A2,
  },
  {
    id:     "animecorner",
    name:   "Anime Corner",
    flag:   "🎌",
    lang:   "anime",
    rssUrl: "https://animecorner.me/feed/",
    color:  0xFF6B6B,
  },
  {
    id:     "otakuusa",
    name:   "Otaku USA",
    flag:   "🎌",
    lang:   "anime",
    rssUrl: "https://otakuusamagazine.com/feed/",
    color:  0xE91E8C,
  },
  {
    id:     "comicnatalie",
    name:   "Comic Natalie",
    flag:   "🇯🇵",
    lang:   "anime",
    rssUrl: "https://natalie.mu/comic/feed/news",
    color:  0x00A0E9,
  },
  // ── International Film & TV ────────────────────────────────────────────────
  {
    id:     "deadline",
    name:   "Deadline",
    flag:   "🎬",
    lang:   "intl",
    rssUrl: "https://deadline.com/feed/",
    color:  0x1A1A2E,
  },
  {
    id:     "variety",
    name:   "Variety",
    flag:   "🎬",
    lang:   "intl",
    rssUrl: "https://variety.com/feed/",
    color:  0xC0392B,
  },
  {
    id:     "collider",
    name:   "Collider",
    flag:   "🎬",
    lang:   "intl",
    rssUrl: "https://collider.com/feed/",
    color:  0x2C3E50,
  },
  {
    id:     "screenrant",
    name:   "Screen Rant",
    flag:   "🎬",
    lang:   "intl",
    rssUrl: "https://screenrant.com/feed/",
    color:  0xE74C3C,
  },
  // ── Korean Drama & Entertainment ──────────────────────────────────────────
  {
    id:     "soompi",
    name:   "Soompi",
    flag:   "🇰🇷",
    lang:   "kr",
    rssUrl: "https://www.soompi.com/feed",
    color:  0x3498DB,
  },
  {
    id:     "dramabeans",
    name:   "Dramabeans",
    flag:   "🇰🇷",
    lang:   "kr",
    rssUrl: "https://www.dramabeans.com/feed/",
    color:  0x9B59B6,
  },
  {
    id:     "koreaboo",
    name:   "Koreaboo",
    flag:   "🇰🇷",
    lang:   "kr",
    rssUrl: "https://www.koreaboo.com/feed/",
    color:  0x1ABC9C,
  },
];

// ─── RSS Parser ───────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 10_000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":     "application/rss+xml, application/xml, text/xml, */*",
  },
});

// ─── DB setup ─────────────────────────────────────────────────────────────────
export async function initTVNewsMonitor(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tv_news_config (
      id         SERIAL PRIMARY KEY,
      guild_id   TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      enabled    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tv_news_seen (
      id         SERIAL PRIMARY KEY,
      article_id TEXT NOT NULL UNIQUE,
      source_id  TEXT NOT NULL,
      seen_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Prune old articles (7 days)
  await pool.query(`
    DELETE FROM tv_news_seen WHERE seen_at < NOW() - INTERVAL '7 days'
  `);
}

// ─── Guild config helpers ─────────────────────────────────────────────────────
export async function setTVNewsChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query(`
    INSERT INTO tv_news_config (guild_id, channel_id, enabled)
    VALUES ($1, $2, TRUE)
    ON CONFLICT (guild_id) DO UPDATE
      SET channel_id = EXCLUDED.channel_id,
          enabled    = TRUE
  `, [guildId, channelId]);
}

export async function stopTVNews(guildId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE tv_news_config SET enabled = FALSE WHERE guild_id = $1`,
    [guildId]
  );
  return (rowCount ?? 0) > 0;
}

export async function getTVNewsConfig(guildId: string): Promise<{ channelId: string; enabled: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT channel_id, enabled FROM tv_news_config WHERE guild_id = $1`,
    [guildId]
  );
  return rows[0] ? { channelId: rows[0].channel_id, enabled: rows[0].enabled } : null;
}

// ─── Fetch & parse one source ─────────────────────────────────────────────────
interface TVItem {
  id:      string;
  title:   string;
  link:    string;
  summary: string;
  pubDate: Date | null;
  source:  TVSource;
}

async function fetchSource(source: TVSource): Promise<TVItem[]> {
  try {
    const feed = await rssParser.parseURL(source.rssUrl);
    const items: TVItem[] = [];

    for (const item of feed.items.slice(0, 8)) {
      const link  = item.link ?? item.guid ?? "";
      const title = item.title?.trim() ?? "";
      if (!title || !link) continue;

      const id = `tv::${source.id}::${item.guid ?? link}`;

      const summary = (item.contentSnippet ?? item.content ?? item.summary ?? "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .slice(0, 220);

      let pubDate: Date | null = null;
      if (item.pubDate) {
        const d = new Date(item.pubDate);
        if (!isNaN(d.getTime())) pubDate = d;
      }

      items.push({ id, title, link, summary, pubDate, source });
    }
    return items;
  } catch (err: any) {
    console.warn(`[TVNews] ${source.name} failed: ${err.message}`);
    return [];
  }
}

// ─── Seen-article helpers ─────────────────────────────────────────────────────
async function filterUnseen(items: TVItem[]): Promise<TVItem[]> {
  if (!items.length) return [];
  const ids = items.map(i => i.id);
  const { rows } = await pool.query(
    `SELECT article_id FROM tv_news_seen WHERE article_id = ANY($1::text[])`,
    [ids]
  );
  const seen = new Set(rows.map((r: any) => r.article_id));
  return items.filter(i => !seen.has(i.id));
}

async function markSeen(items: TVItem[]): Promise<void> {
  for (const item of items) {
    await pool.query(
      `INSERT INTO tv_news_seen (article_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [item.id, item.source.id]
    );
  }
}

// ─── Build Discord embed ──────────────────────────────────────────────────────
function buildEmbed(item: TVItem): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const src = item.source;

  const categoryLabel =
    src.lang === "anime" ? "🎌 Anime & Manga" :
    src.lang === "kr"    ? "🇰🇷 K-Drama / K-Pop" :
    "🎬 Film & TV";

  const embed = new EmbedBuilder()
    .setColor(src.color)
    .setAuthor({ name: `${src.flag} ${src.name}` })
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setFooter({ text: categoryLabel });

  if (item.summary) embed.setDescription(item.summary);
  if (item.pubDate) embed.setTimestamp(item.pubDate);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("اقرأ المزيد / Read More")
      .setStyle(ButtonStyle.Link)
      .setURL(item.link)
      .setEmoji("🔗")
  );

  return { embed, row };
}

// ─── Post to all guilds ───────────────────────────────────────────────────────
async function postToGuilds(client: Client, items: TVItem[]): Promise<void> {
  if (!items.length) return;

  const { rows: configs } = await pool.query(
    `SELECT guild_id, channel_id FROM tv_news_config WHERE enabled = TRUE`
  );
  if (!configs.length) return;

  for (const cfg of configs) {
    try {
      const ch = await client.channels.fetch(cfg.channel_id).catch(() => null) as TextChannel | null;
      if (!ch?.isTextBased()) continue;

      for (const item of items) {
        try {
          const { embed, row } = buildEmbed(item);
          await ch.send({ embeds: [embed], components: [row] });
          await new Promise(r => setTimeout(r, 700));
        } catch (err: any) {
          console.warn(`[TVNews] Post failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.warn(`[TVNews] Channel fetch failed: ${err.message}`);
    }
  }
}

// ─── Poll cycle ───────────────────────────────────────────────────────────────
async function runPollCycle(client: Client): Promise<void> {
  const { rows: lock } = await pool.query(
    `SELECT pg_try_advisory_lock($1) AS acquired`, [LOCK_KEY]
  );
  if (!lock[0]?.acquired) return;

  try {
    const { rows: active } = await pool.query(
      `SELECT 1 FROM tv_news_config WHERE enabled = TRUE LIMIT 1`
    );
    if (!active.length) return;

    const results = await Promise.allSettled(TV_SOURCES.map(s => fetchSource(s)));
    const all: TVItem[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value);
    }
    if (!all.length) return;

    const fresh = await filterUnseen(all);
    if (!fresh.length) {
      console.log(`[TVNews] 0 new items`);
      return;
    }

    await markSeen(fresh);

    // Sort oldest → newest
    fresh.sort((a, b) => (a.pubDate?.getTime() ?? 0) - (b.pubDate?.getTime() ?? 0));

    console.log(`[TVNews] ${fresh.length} new item(s) to post`);
    await postToGuilds(client, fresh);

  } finally {
    await pool.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
  }
}

// ─── Register ─────────────────────────────────────────────────────────────────
export function registerTVNewsMonitor(client: Client): void {
  initTVNewsMonitor()
    .then(() => {
      console.log("[TVNews] Initialized — polling every 15 min");

      setTimeout(() => {
        runPollCycle(client).catch(e => console.error("[TVNews] Initial poll error:", e));
      }, 45_000); // 45s after startup (stagger from news-monitor's 30s)

      setInterval(() => {
        runPollCycle(client).catch(e => console.error("[TVNews] Poll error:", e));
      }, POLL_INTERVAL_MS);
    })
    .catch(e => console.error("[TVNews] Init failed:", e));
}
